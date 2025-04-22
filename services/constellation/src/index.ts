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

const runWithLog = <T>(meta: Record<string, unknown>, fn: () => Promise<T>): Promise<T> =>
  withLogger(meta, async () => {
    try {
      return await fn();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      getLogger().error({ err }, 'Unhandled error');
      throw err;
    }
  });

// Define a type for dead letter queue payloads
type DeadLetterPayload =
  | { error: string; originalMessage: unknown }
  | { err: string; job: SiloEmbedJob };

const sendToDeadLetter = async (queue: DeadQueue | undefined, payload: DeadLetterPayload) => {
  if (!queue) return;
  try {
    await queue.send(payload);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
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

  /* ----------------------- dead letter queue consumer ----------------------- */

  async deadLetterQueue(batch: MessageBatch<unknown>) {
    await runWithLog(
      { service: 'constellation', op: 'deadLetterQueue', size: batch.messages.length, ...this.env },
      async () => {
        metrics.gauge('deadletter.batch_size', batch.messages.length);

        let processedCount = 0;
        let retryCount = 0;
        let malformedCount = 0;

        for (const msg of batch.messages) {
          try {
            if (!msg.body) {
              getLogger().warn('Empty message body in dead letter queue');
              msg.ack();
              continue;
            }

            const body = msg.body as Record<string, unknown>;

            // Handle the two types of dead letter messages with more robust validation
            if (typeof body === 'object' && body !== null) {
              if ('error' in body && 'originalMessage' in body) {
                // This is a parsing error
                await this.handleParsingError({
                  error: String(body.error),
                  originalMessage: body.originalMessage
                });
                processedCount++;
              } else if ('err' in body && 'job' in body && typeof body.job === 'object' && body.job !== null) {
                // This is an embedding error - validate the job object has minimum required fields
                const job = body.job as Record<string, unknown>;

                // Ensure job has minimum required fields or provide defaults
                const validJob: SiloEmbedJob = {
                  userId: typeof job.userId === 'string' ? job.userId : 'unknown',
                  contentId: typeof job.contentId === 'string' ? job.contentId : 'unknown',
                  text: typeof job.text === 'string' ? job.text : '',
                  created: typeof job.created === 'number' ? job.created : Date.now(),
                  version: typeof job.version === 'number' ? job.version : 1,
                  category: typeof job.category === 'string' ? job.category as any : 'unknown',
                  mimeType: typeof job.mimeType === 'string' ? job.mimeType as any : 'text/plain',
                };

                const shouldRetry = await this.handleEmbeddingError({
                  err: String(body.err),
                  job: validJob
                }, msg.attempts);

                if (shouldRetry && msg.attempts < 3) {
                  // Retry with exponential backoff
                  const delaySeconds = Math.pow(2, msg.attempts) * 30;
                  msg.retry({ delaySeconds });
                  retryCount++;
                  continue;
                } else {
                  processedCount++;
                }
              } else {
                // Unknown or malformed message format
                getLogger().error(
                  { body: body, keys: Object.keys(body) },
                  'Malformed message in dead letter queue'
                );
                malformedCount++;
              }
            } else {
              getLogger().error(
                { bodyType: typeof body, body },
                'Invalid message type in dead letter queue'
              );
              malformedCount++;
            }
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            getLogger().error(
              { err, body: msg.body },
              'Error processing dead letter queue message',
            );
            malformedCount++;
          } finally {
            // Always acknowledge the message unless we've explicitly retried it
            msg.ack();
          }
        }

        getLogger().info(
          {
            processed: processedCount,
            retried: retryCount,
            malformed: malformedCount,
            total: batch.messages.length
          },
          'Processed dead letter queue batch',
        );

        metrics.increment('deadletter.messages_processed', processedCount);
        metrics.increment('deadletter.messages_retried', retryCount);
        metrics.increment('deadletter.messages_malformed', malformedCount);
      },
    );
  }

  /**
   * Handle a parsing error from the dead letter queue
   * These errors occur when a message from the new-content queue fails validation
   */
  private async handleParsingError(payload: { error: string; originalMessage: unknown }) {
    getLogger().info(
      { error: payload.error },
      'Processing parsing error from dead letter queue',
    );

    // Log detailed information about the parsing error
    const { error, originalMessage } = payload;

    // Attempt to extract any useful information from the original message
    let contentId = 'unknown';
    let userId = 'unknown';
    let messageDetails: Record<string, unknown> = {};

    if (originalMessage && typeof originalMessage === 'object') {
      // Safely extract all available fields for debugging
      messageDetails = { ...originalMessage as Record<string, unknown> };

      if ('id' in messageDetails && typeof messageDetails.id === 'string') {
        contentId = messageDetails.id;
      } else if ('contentId' in messageDetails && typeof messageDetails.contentId === 'string') {
        contentId = messageDetails.contentId;
      }

      if ('userId' in messageDetails) {
        userId = messageDetails.userId === null ? 'null' : String(messageDetails.userId);
      }
    }

    getLogger().info(
      { contentId, userId, error, messageFields: Object.keys(messageDetails) },
      'Parsing error details from dead letter queue'
    );

    // Currently we just log the error - in the future we could implement
    // recovery strategies based on the specific error type
    metrics.increment('deadletter.parsing_errors_processed');
  }

  /**
   * Handle an embedding error from the dead letter queue
   * These errors occur during the embedding process
   * @returns boolean indicating whether the job should be retried
   */
  private async handleEmbeddingError(
    payload: { err: string; job: SiloEmbedJob },
    attempts: number,
  ): Promise<boolean> {
    const { err, job } = payload;

    // Validate job has required fields with fallbacks for safety
    const contentId = job.contentId || 'unknown';
    const userId = job.userId || 'unknown';

    getLogger().info(
      {
        error: err,
        contentId,
        userId,
        attempts,
        jobFields: Object.keys(job)
      },
      'Processing embedding error from dead letter queue',
    );

    // Analyze the error to determine if it's retryable
    const isRetryable = this.isRetryableError(err);

    if (isRetryable && attempts < 3) {
      getLogger().info(
        { contentId, error: err, attempts },
        'Will retry embedding job',
      );
      return true;
    }

    // For non-retryable errors or max attempts reached, log and move on
    getLogger().warn(
      { contentId, error: err, attempts },
      'Embedding error cannot be retried or max attempts reached',
    );

    metrics.increment('deadletter.embedding_errors_processed');
    return false;
  }

  /**
   * Determine if an error is retryable based on the error message
   */
  private isRetryableError(errorMessage: string): boolean {
    // Errors that might be temporary and worth retrying
    const retryablePatterns = [
      /timeout/i,
      /connection/i,
      /network/i,
      /throttl/i,
      /rate limit/i,
      /too many requests/i,
      /service unavailable/i,
      /internal server error/i,
      /5\d\d/, // 5xx status codes
      /temporarily unavailable/i,
      /overloaded/i,
      /try again/i,
      /resource exhausted/i
    ];

    return retryablePatterns.some(pattern => pattern.test(errorMessage));
  }

  /* ----------------------- embed a batch of notes ----------------------- */

  private async embedBatch(jobs: SiloEmbedJob[], deadQueue?: DeadQueue): Promise<number> {
    let processed = 0;
    const MAX_CHUNKS_PER_BATCH = 50; // Limit chunks processed at once
    const MAX_TEXT_LENGTH = 100000; // Limit text size to prevent memory issues

    // Process jobs one at a time to avoid memory issues
    for (const job of jobs) {
      const span = metrics.startTimer('process_job');
      try {
        const { preprocessor, embedder, vectorize } = this.services;

        // Truncate extremely large texts to prevent memory issues
        const truncatedText =
          job.text.length > MAX_TEXT_LENGTH ? job.text.substring(0, MAX_TEXT_LENGTH) : job.text;

        if (truncatedText.length < job.text.length) {
          getLogger().warn(
            {
              originalLength: job.text.length,
              truncatedLength: truncatedText.length,
              contentId: job.contentId,
            },
            'Text truncated to prevent memory issues',
          );
        }

        // Process the text into chunks
        const chunks = preprocessor.process(truncatedText);
        if (chunks.length === 0) {
          getLogger().warn({ job }, 'no text');
          continue;
        }

        getLogger().info(
          {
            chunks: chunks.length,
            textLength: truncatedText.length,
            contentId: job.contentId,
          },
          'preprocessed chunks',
        );

        // Process chunks in smaller batches to avoid memory issues
        let allVectors: { id: string; values: number[]; metadata: VectorMeta }[] = [];

        for (let i = 0; i < chunks.length; i += MAX_CHUNKS_PER_BATCH) {
          const batchChunks = chunks.slice(i, i + MAX_CHUNKS_PER_BATCH);

          getLogger().debug(
            {
              batchIndex: Math.floor(i / MAX_CHUNKS_PER_BATCH) + 1,
              totalBatches: Math.ceil(chunks.length / MAX_CHUNKS_PER_BATCH),
              batchSize: batchChunks.length,
              contentId: job.contentId,
            },
            'Processing chunk batch',
          );

          // Generate embeddings for this batch of chunks
          const batchVectors = (await embedder.embed(batchChunks)).map((v, idx) => ({
            id: `content:${job.contentId}:${i + idx}`,
            values: v,
            metadata: <VectorMeta>{
              userId: job.userId,
              contentId: job.contentId,
              category: job.category,
              mimeType: job.mimeType,
              createdAt: Math.floor(job.created / 1000),
              version: job.version,
            },
          }));

          allVectors = allVectors.concat(batchVectors);

          // Force garbage collection between batches by breaking reference
          batchChunks.length = 0;

          // Add a small delay between batches to allow for garbage collection
          if (i + MAX_CHUNKS_PER_BATCH < chunks.length) {
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        }

        // Upsert vectors in smaller batches
        const UPSERT_BATCH_SIZE = 100;
        for (let i = 0; i < allVectors.length; i += UPSERT_BATCH_SIZE) {
          const upsertBatch = allVectors.slice(i, i + UPSERT_BATCH_SIZE);
          await vectorize.upsert(upsertBatch);

          getLogger().debug(
            {
              upsertBatchIndex: Math.floor(i / UPSERT_BATCH_SIZE) + 1,
              totalUpsertBatches: Math.ceil(allVectors.length / UPSERT_BATCH_SIZE),
              batchSize: upsertBatch.length,
              contentId: job.contentId,
            },
            'Upserting vector batch',
          );
        }

        getLogger().info(
          {
            vectorCount: allVectors.length,
            contentId: job.contentId,
            textLength: truncatedText.length,
          },
          'upserted vectors',
        );

        processed += 1;

        // Clear references to large objects to help garbage collection
        chunks.length = 0;
        allVectors.length = 0;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        getLogger().error({ err, contentId: job.contentId }, 'embed failed');
        await sendToDeadLetter(deadQueue, { err: String(err), job });
      } finally {
        span.stop();
      }

      // Add a delay between jobs to allow for garbage collection
      if (jobs.indexOf(job) < jobs.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
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
    return runWithLog({ service: 'constellation', op: 'stats', ...this.env }, async () => {
      try {
        return await this.services.vectorize.getStats();
      } catch (error) {
        return { error };
      }
    });
  }
}
