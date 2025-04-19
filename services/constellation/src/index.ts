import { WorkerEntrypoint } from 'cloudflare:workers';
import { EmbedJob, NoteVectorMeta, VectorSearchResult } from '@dome/common';

import { withLogger } from '@dome/logging';
import { logger } from './utils/logging';
import { metrics } from './utils/metrics';
import { createPreprocessor } from './services/preprocessor';
import { createEmbedder } from './services/embedder';
import { createVectorizeService } from './services/vectorize';

/* -------------------------------------------------------------------------- */
/*  helpers                                                                    */
/* -------------------------------------------------------------------------- */

const services = (env: Env) => ({
  preprocessor: createPreprocessor(),
  embedder: createEmbedder(env.AI),
  vectorize: createVectorizeService(env.VECTORIZE),
});

async function wrap<T>(meta: Record<string, unknown>, fn: () => Promise<T>) {
  return withLogger(meta, async () => {
    try {
      return await fn();
    } catch (err) {
      logger.error({ err }, 'Unhandled error');
      throw err;
    }
  });
}

/* -------------------------------------------------------------------------- */
/*  worker                                                                     */
/* -------------------------------------------------------------------------- */

export default class Constellation extends WorkerEntrypoint<Env> {
  /* ------- embed a batch of notes -------------------------------------- */
  private async embedBatch(
    jobs: EmbedJob[],
    dead?: (j: EmbedJob) => Promise<void>,
  ): Promise<number> {
    const { preprocessor, embedder, vectorize } = services(this.env);
    let ok = 0;

    for (const job of jobs) {
      const span = metrics.startTimer('process_job');
      try {
        const chunks = preprocessor.process(job.text);
        if (!chunks.length) {
          logger.warn({ job }, 'no text');
          continue;
        }

        const vecs = (await embedder.embed(chunks)).map((v, i) => ({
          id: `note:${job.noteId}:${i}`,
          values: v,
          metadata: <NoteVectorMeta>{
            userId: job.userId,
            noteId: job.noteId,
            createdAt: (job.created / 1000) | 0,
            version: job.version,
          },
        }));

        await vectorize.upsert(vecs);
        ok++;
      } catch (err) {
        logger.error({ err, job }, 'embed failed');
        if (dead) await dead(job);
        throw err; // queue retry will handle
      } finally {
        span.stop();
      }
    }
    return ok;
  }

  /* ------- queue consumer ---------------------------------------------- */
  async queue(batch: MessageBatch<EmbedJob>) {
    await wrap(
      { service: 'constellation', op: 'queue', size: batch.messages.length, ...this.env },
      async () => {
        metrics.gauge('queue.batch_size', batch.messages.length);

        const ok = await this.embedBatch(
          batch.messages.map(m => m.body),
          j => this.env.EMBED_DEAD?.send(j),
        );

        metrics.increment('queue.jobs_processed', ok);
      },
    );
  }

  /* ------- rpc: embed --------------------------------------------------- */
  public async embed(job: EmbedJob) {
    await wrap(
      { service: 'constellation', op: 'embed', note: job.noteId, user: job.userId, ...this.env },
      async () => {
        metrics.increment('rpc.embed.requests');
        await this.embedBatch([job]);
        metrics.increment('rpc.embed.success');
      },
    );
  }

  /* ------- rpc: query --------------------------------------------------- */
  public async query(
    text: string,
    filter: Partial<NoteVectorMeta>,
    topK = 10,
  ): Promise<VectorSearchResult[]> {
    return wrap({ service: 'constellation', op: 'query', filter, topK, ...this.env }, async () => {
      const { preprocessor, embedder, vectorize } = services(this.env);

      const norm = preprocessor.normalize(text);
      if (!norm) return [];

      const [queryVec] = await embedder.embed([norm]);
      const results = await vectorize.query(queryVec, filter, topK);

      metrics.increment('rpc.query.success');
      metrics.gauge('rpc.query.results', results.length);
      return results;
    });
  }

  /* ------- rpc: stats --------------------------------------------------- */
  public async stats() {
    return wrap({ service: 'constellation', op: 'stats', ...this.env }, async () =>
      services(this.env).vectorize.getStats(),
    );
  }
}
