import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  SiloEmbedJob,
  VectorMeta,
  VectorSearchResult,
  NewContentMessageSchema,
} from '@dome/common';
import { z } from 'zod';

import { withLogger, getLogger, metrics } from '@dome/logging';
import { createPreprocessor } from './services/preprocessor';
import { createEmbedder } from './services/embedder';
import { createVectorizeService } from './services/vectorize';
import { createSiloService } from './services/siloService';

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

type DeadQueue = Env['EMBED_DEAD'];

const buildServices = (env: Env) => ({
  preprocessor: createPreprocessor(),
  embedder: createEmbedder(env.AI),
  vectorize: createVectorizeService(env.VECTORIZE),
  silo: createSiloService(env),
});

const runWithLog = <T>(
  meta: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> =>
  withLogger(meta, async () => {
    try {
      return await fn();
    } catch (err) {
      getLogger().error({ err }, 'Unhandled error');
      throw err;
    }
  });

// Define a type for dead letter queue payloads
type DeadLetterPayload =
  | { error: string; originalMessage: unknown }
  | { err: string; job: SiloEmbedJob };

const sendToDeadLetter = async (
  queue: DeadQueue | undefined,
  payload: DeadLetterPayload,
) => {
  if (!queue) return;
  try {
    await queue.send(payload);
  } catch (err) {
    getLogger().error({ err, payload }, 'Failed to write to dead‑letter queue');
  }
};

/* -------------------------------------------------------------------------- */
/* worker                                                                     */
/* -------------------------------------------------------------------------- */

export default class Constellation extends WorkerEntrypoint<Env> {
  /** Lazily created bundle of service clients (re‑used for every call) */
  private _services?: ReturnType<typeof buildServices>;
  private get services() {
    return (this._services ??= buildServices(this.env));
  }

  /* ----------------------- embed a batch of notes ----------------------- */

  private async embedBatch(
    jobs: SiloEmbedJob[],
    deadQueue?: DeadQueue,
  ): Promise<number> {
    let processed = 0;

    for (const job of jobs) {
      const span = metrics.startTimer('process_job');
      try {
        const { preprocessor, embedder, vectorize } = this.services;

        const chunks = preprocessor.process(job.text);
        if (chunks.length === 0) {
          getLogger().warn({ job }, 'no text');
          continue;
        }

        getLogger().info({ chunks: chunks.length }, 'preprocesed chunks');
        const vecs = (await embedder.embed(chunks)).map((v, i) => ({
          id: `content:${job.contentId}:${i}`,
          values: v,
          metadata: <VectorMeta>{
            userId: job.userId,
            contentId: job.contentId,
            contentType: job.contentType,
            createdAt: Math.floor(job.created / 1000),
            version: job.version,
          },
        }));

        await vectorize.upsert(vecs);
        getLogger().info({ vectorCount: vecs.length }, 'upserted vectors');
        processed += 1;
      } catch (err) {
        getLogger().error({ err, job }, 'embed failed');
        await sendToDeadLetter(deadQueue, { err: String(err), job });
      } finally {
        span.stop();
      }
    }

    return processed;
  }

  /* ---------------------------- queue consumer -------------------------- */

  async queue(batch: MessageBatch<Record<string, unknown>>) {
    await runWithLog(
      { service: 'constellation', op: 'queue', size: batch.messages.length, ...this.env },
      async () => {
        metrics.gauge('queue.batch_size', batch.messages.length);

        const embedJobs: SiloEmbedJob[] = [];

        for (const msg of batch.messages) {
          const jobOrErr = await this.parseMessage(msg);
          if (jobOrErr instanceof Error) {
            await sendToDeadLetter(this.env.EMBED_DEAD, {
              error: jobOrErr.message,
              originalMessage: msg.body,
            });
          } else {
            embedJobs.push(jobOrErr);
          }
          msg.ack(); // always ack exactly once
        }

        if (embedJobs.length) {
          getLogger().info({ count: embedJobs.length }, 'Processing embed jobs');
          const ok = await this.embedBatch(embedJobs, this.env.EMBED_DEAD);
          metrics.increment('queue.jobs_processed', ok);
        }
      },
    );
  }

  /** Validate + convert a single queue message */
  private async parseMessage(msg: Message<Record<string, unknown>>): Promise<SiloEmbedJob | Error> {
    if (!msg.body) return new Error('Message body is empty');

    const validation = NewContentMessageSchema.safeParse(msg.body);
    if (!validation.success) {
      const issues = validation.error.issues
        .map(i => `${i.path.join('.')}: ${i.message}`)
        .join(', ');
      getLogger().error({ issues }, 'Invalid message body');
      return new Error(`Validation error: ${issues}`);
    }

    try {
      // At this point, we know the message body conforms to NewContentMessage schema
      return await this.services.silo.convertToEmbedJob(validation.data);
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  }

  /* ---------------------------- rpc: embed ------------------------------ */

  public async embed(job: SiloEmbedJob) {
    await runWithLog(
      {
        service: 'constellation',
        op: 'embed',
        content: job.contentId,
        user: job.userId,
        ...this.env,
      },
      async () => {
        metrics.increment('rpc.embed.requests');
        await this.embedBatch([job]);
        metrics.increment('rpc.embed.success');
      },
    );
  }

  /* ---------------------------- rpc: query ------------------------------ */

  public async query(
    text: string,
    filter: Partial<VectorMeta>,
    topK = 10,
  ): Promise<VectorSearchResult[] | { error: unknown }> {
    return runWithLog(
      { service: 'constellation', op: 'query', filter, topK, ...this.env },
      async () => {
        try {
          const { preprocessor, embedder, vectorize } = this.services;

          const norm = preprocessor.normalize(text);
          if (!norm) return [];
          getLogger().info({ norm }, 'normalized text');

          const [queryVec] = await embedder.embed([norm]);
          getLogger().info({ queryVec }, 'got embedding for the query');
          const results = await vectorize.query(queryVec, filter, topK);
          getLogger().info({ results }, 'query results');

          metrics.increment('rpc.query.success');
          metrics.gauge('rpc.query.results', results.length);
          return results;
        } catch (error) {
          return { error };
        }
      },
    );
  }

  /* ---------------------------- rpc: stats ------------------------------ */

  public async stats() {
    return runWithLog(
      { service: 'constellation', op: 'stats', ...this.env },
      async () => {
        try {
          return await this.services.vectorize.getStats();
        } catch (error) {
          return { error };
        }
      },
    );
  }
}
