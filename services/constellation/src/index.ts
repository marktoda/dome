import { WorkerEntrypoint } from 'cloudflare:workers';
import { EmbedJob, NoteVectorMeta, VectorSearchResult } from '@dome/common';
import { runWithLogger, getLogger } from '@dome/logging';
import { QueueMessage, CFExecutionContext } from './types';
import { createPreprocessor } from './services/preprocessor';
import { createEmbedder } from './services/embedder';
import { createVectorizeService } from './services/vectorize';
import { metrics } from './utils/metrics';
import { logger } from './utils/logging';

/**
 * Create a wrapper around ExecutionContext that adds the run method
 * required by the runWithLogger function
 */
function createCFExecutionContext(ctx: ExecutionContext): CFExecutionContext {
  return {
    ...ctx,
    run: async <T>(callback: () => T): Promise<T> => {
      return Promise.resolve(callback());
    },
    waitUntil: ctx.waitUntil.bind(ctx),
    passThroughOnException: ctx.passThroughOnException.bind(ctx)
  };
}

export default class Constellation extends WorkerEntrypoint<Env> {
  /**
   * Process a batch of embedding jobs
   * @param jobs Array of embedding jobs to process
   * @param env Environment variables and bindings
   * @param sendToDeadLetter Function to send failed jobs to dead letter queue
   * @returns Number of successfully processed jobs
   */
  private async embedBatch(
    jobs: EmbedJob[],
    env: Env,
    sendToDeadLetter?: (job: EmbedJob) => Promise<void>
  ): Promise<number> {
    // Initialize services
    const preprocessor = createPreprocessor();
    const embedder = createEmbedder(env.AI);
    const vectorizeService = createVectorizeService(env.VECTORIZE);
    
    let successCount = 0;

    // Process each job
    for (const job of jobs) {
      const jobTimer = metrics.startTimer('process_job');
      try {
        logger.debug({ userId: job.userId, noteId: job.noteId }, 'Processing embedding job');

        // 1. Preprocess text
        const processedTexts = preprocessor.process(job.text);
        if (processedTexts.length === 0) {
          logger.warn({ userId: job.userId, noteId: job.noteId }, 'No text chunks to embed after preprocessing');
          continue;
        }

        // 2. Generate embeddings
        const embeddings = await embedder.embed(processedTexts);

        // 3. Prepare vectors for storage
        const vectors = embeddings.map((embedding, i) => ({
          id: `note:${job.noteId}:${i}`,
          values: embedding,
          metadata: {
            userId: job.userId,
            noteId: job.noteId,
            createdAt: Math.floor(job.created / 1000),
            version: job.version,
          } satisfies NoteVectorMeta
        }));

        // 4. Store vectors
        await vectorizeService.upsert(vectors);

        logger.info(
          { userId: job.userId, noteId: job.noteId, chunks: processedTexts.length },
          'Successfully embedded and stored note'
        );
        successCount++;
      } catch (error) {
        logger.error(
          { error, userId: job.userId, noteId: job.noteId },
          'Error processing embedding job'
        );

        // If we have a dead letter handler, use it
        if (sendToDeadLetter) {
          await sendToDeadLetter(job);
          logger.info({ userId: job.userId, noteId: job.noteId }, 'Sent failed job to dead letter queue');
        }

        // Rethrow the error to allow the caller to handle retries
        throw error;
      } finally {
        jobTimer.stop({ userId: job.userId, noteId: job.noteId });
      }
    }

    return successCount;
  }

  /* ---------------- Queue Consumer ---------------- */
  async queue(batch: MessageBatch<EmbedJob>): Promise<void> {
    await runWithLogger(
      {
        service: 'constellation',
        operation: 'queue_consumer',
        batchSize: batch.messages.length,
        environment: this.env.ENVIRONMENT,
        version: this.env.VERSION,
      },
      async () => {
        try {
          logger.info({ batchSize: batch.messages.length }, 'Processing embedding batch');
          metrics.gauge('queue.batch_size', batch.messages.length);
          const batchTimer = metrics.startTimer('queue.process_batch');

          // Extract jobs from batch
          const jobs = batch.messages.map(m => m.body);

          // Process the batch with dead letter queue handling
          const sendToDeadLetter = async (job: EmbedJob) => {
            if (this.env.EMBED_DEAD) {
              await this.env.EMBED_DEAD.send(job);
            }
          };

          const successCount = await this.embedBatch(jobs, this.env, sendToDeadLetter);
          metrics.increment('queue.jobs_processed', successCount);

          batchTimer.stop();
          logger.info({ processedCount: successCount }, 'Batch processing completed');
        } catch (error) {
          logger.error({ error }, 'Error processing batch');
          metrics.increment('queue.batch_errors');

          // Retry the entire batch if appropriate
          if (batch.retryAll) {
            batch.retryAll();
          }
        }
      },
      createCFExecutionContext(this.ctx)
    );
  }

  /* ---------------- RPC Methods ---------------- */
  /** Embed a single note immediately (rare). */
  public async embed(env: Env, job: EmbedJob): Promise<void> {
    await runWithLogger(
      {
        service: 'constellation',
        operation: 'embed',
        userId: job.userId,
        noteId: job.noteId,
        environment: env.ENVIRONMENT,
        version: env.VERSION,
      },
      async () => {
        logger.info({ userId: job.userId, noteId: job.noteId }, 'Processing direct embedding request');
        metrics.increment('rpc.embed.requests');
        const timer = metrics.startTimer('rpc.embed');

        try {
          // Process the job directly using the embedBatch helper
          await this.embedBatch([job], env);
          metrics.increment('rpc.embed.success');
        } catch (error) {
          metrics.increment('rpc.embed.errors');
          logger.error({ error, userId: job.userId, noteId: job.noteId }, 'Error in direct embedding');
          throw error;
        } finally {
          timer.stop();
        }
      },
      createCFExecutionContext(this.ctx)
    );
  }

  /** Vector/text similarity search. */
  public async query(
    env: Env,
    text: string,
    filter: Partial<NoteVectorMeta>,
    topK = 10
  ): Promise<VectorSearchResult[]> {
    return await runWithLogger(
      {
        service: 'constellation',
        operation: 'query',
        filter,
        topK,
        environment: env.ENVIRONMENT,
        version: env.VERSION,
      },
      async () => {
        logger.info({ filter, topK }, 'Processing vector search query');
        metrics.increment('rpc.query.requests');
        const timer = metrics.startTimer('rpc.query');

        try {
          // Initialize services
          const preprocessor = createPreprocessor();
          const embedder = createEmbedder(env.AI);
          const vectorizeService = createVectorizeService(env.VECTORIZE);

          // Preprocess query text
          const processedText = preprocessor.normalize(text);
          if (!processedText) {
            logger.warn('Empty query text after preprocessing');
            return [];
          }

          // Generate embedding for the query text
          const embeddings = await embedder.embed([processedText]);
          if (embeddings.length === 0) {
            logger.warn('Failed to generate embedding for query text');
            return [];
          }

          // Query the vector index with the generated embedding
          const queryVector = embeddings[0];
          const results = await vectorizeService.query(queryVector, filter, topK);

          metrics.increment('rpc.query.success');
          metrics.gauge('rpc.query.results', results.length);
          logger.info({ resultCount: results.length }, 'Vector search completed');

          return results;
        } catch (error) {
          metrics.increment('rpc.query.errors');
          logger.error({ error, filter, topK }, 'Error in vector search');
          throw error;
        } finally {
          timer.stop();
        }
      },
      createCFExecutionContext(this.ctx)
    );
  }

  /** Lightweight health/stat endpoint. */
  public async stats(env: Env): Promise<{ vectors: number; dimension: number }> {
    return await runWithLogger(
      {
        service: 'constellation',
        operation: 'stats',
        environment: env.ENVIRONMENT,
        version: env.VERSION,
      },
      async () => {
        logger.info('Processing stats request');
        metrics.increment('rpc.stats.requests');
        const timer = metrics.startTimer('rpc.stats');

        try {
          // Initialize service
          const vectorizeService = createVectorizeService(env.VECTORIZE);

          // Get index stats
          const stats = await vectorizeService.getStats();

          metrics.increment('rpc.stats.success');
          logger.info({ stats }, 'Stats request completed');

          return stats;
        } catch (error) {
          metrics.increment('rpc.stats.errors');
          logger.error({ error }, 'Error getting stats');
          throw error;
        } finally {
          timer.stop();
        }
      },
      createCFExecutionContext(this.ctx)
    );
  }
}
