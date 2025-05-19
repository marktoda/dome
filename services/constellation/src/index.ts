import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  VectorMeta,
  VectorSearchResult,
  NewContentMessageSchema,
  EmbedDeadLetterMessageSchema,
  parseMessageBatch,
  ParsedMessageBatch,
  ParsedQueueMessage,
  RawMessageBatch,
  NewContentMessage,
  SiloContentItem,
  serializeQueueMessage,
} from '@dome/common';
import { z } from 'zod';

import { withContext } from '@dome/common';
import {
  getLogger,
  logError,
  trackOperation,
  constellationMetrics as metrics,
} from './utils/logging';
import {
  toDomeError,
  assertValid,
  assertExists,
  ValidationError,
  VectorizeError,
  EmbeddingError,
  PreprocessingError,
} from './utils/errors';
import { createPreprocessor } from './services/preprocessor';
import { createEmbedder } from './services/embedder';
import { createVectorizeService } from './services/vectorize';
import { SiloClient, SiloBinding } from '@dome/silo/client';
interface ServiceEnv extends Omit<Cloudflare.Env, 'SILO'> {
  SILO: SiloBinding;
}

const logger = getLogger();

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

type DeadQueue = ServiceEnv['EMBED_DEAD'];

const buildServices = (env: ServiceEnv) => ({
  preprocessor: createPreprocessor(),
  embedder: createEmbedder(env.AI),
  vectorize: createVectorizeService(env.VECTORIZE), // Reverted to 'vectorize'
  silo: new SiloClient(env.SILO),
});

/**
 * Run a function with enhanced logging and error handling
 * @param meta Metadata for logging context
 * @param fn Function to execute
 * @returns Result of the function
 */
const runWithLog = <T>(meta: Record<string, unknown>, fn: () => Promise<T>): Promise<T> =>
  withContext(meta, async logger => {
    try {
      return await fn();
    } catch (err) {
      const requestId = typeof meta.requestId === 'string' ? meta.requestId : undefined;
      const operation = typeof meta.op === 'string' ? meta.op : 'unknown_operation';

      const errorContext = {
        operation,
        requestId,
        service: 'constellation',
        timestamp: new Date().toISOString(),
        ...meta,
      };

      logError(err, `Unhandled error in ${operation}`, errorContext);

      // Convert to a proper DomeError before rethrowing
      throw toDomeError(err, `Error in ${operation}`, errorContext);
    }
  });

// Define a type for dead letter queue payloads
type DeadLetterPayload =
  | { error: string; originalMessage: unknown; errorCode?: string }
  | { err: string; job: SiloContentItem; errorCode?: string; timestamp?: number };

/**
 * Send a failed message to the dead letter queue with enhanced error context
 * @param queue Dead letter queue
 * @param payload Payload to send to dead letter queue
 * @param requestId Request ID for correlation
 */
const sendToDeadLetter = async (
  queue: DeadQueue | undefined,
  payload: DeadLetterPayload,
  requestId: string = crypto.randomUUID(),
) => {
  if (!queue) {
    logger.warn(
      {
        requestId,
        operation: 'sendToDeadLetter',
        payloadType: typeof payload,
      },
      'Dead letter queue not available, skipping DLQ send',
    );
    return;
  }

  return trackOperation(
    'send_to_dlq',
    async () => {
      try {
        logger.info(
          {
            requestId,
            operation: 'sendToDeadLetter',
            hasError: 'error' in payload,
            contentId: ('job' in payload && payload.job.id) || undefined,
          },
          'Sending message to dead letter queue',
        );

        const message = 'error' in payload
          ? { error: payload.error, originalMessage: payload.originalMessage }
          : { error: payload.err, originalMessage: payload.job };

        const serialized = serializeQueueMessage(
          EmbedDeadLetterMessageSchema,
          message,
        );

        await queue.send(serialized);

        metrics.counter('dlq.messages_sent', 1);

        logger.info(
          { requestId, operation: 'sendToDeadLetter' },
          'Successfully sent message to dead letter queue',
        );
      } catch (err) {
        const domeError = toDomeError(err, 'Failed to send to dead letter queue', {
          requestId,
          operation: 'sendToDeadLetter',
          payloadType: typeof payload,
        });

        logError(domeError, 'Error sending message to dead letter queue');
        metrics.counter('dlq.errors', 1);
        throw domeError;
      }
    },
    { requestId },
  );
};

/* -------------------------------------------------------------------------- */
/* worker                                                                     */
/* -------------------------------------------------------------------------- */

export default class Constellation extends WorkerEntrypoint<ServiceEnv> {
  /** Lazily created bundle of service clients (re‑used for every call) */
  private _services?: ReturnType<typeof buildServices>;
  private get services() {
    return (this._services ??= buildServices(this.env));
  }

  /* ----------------------- embed a batch of notes ----------------------- */


  /**
   * Process and embed a batch of content items
   * @param messages Parsed queue messages to process
   * @param deadQueue Dead letter queue for failed items
   * @param batchRequestId Request ID for the entire batch
   * @returns Number of successfully processed items
   */
  private async embedBatch(
    messages: ParsedQueueMessage<NewContentMessage>[],
    deadQueue?: DeadQueue,
    batchRequestId: string = crypto.randomUUID(),
  ): Promise<number> {
    return trackOperation(
      'embed_batch',
      async () => {
        const MAX_CHUNKS_PER_BATCH = 50;
        const MAX_TEXT_LENGTH = 100000;

        let processed = 0;
        const startTime = Date.now();

        logger.info(
          { batchRequestId, jobCount: messages.length, operation: 'embedBatch' },
          `Starting embedding batch with ${messages.length} jobs`,
        );

        for (const msg of messages) {
          const jobRequestId = `${batchRequestId}-${msg.id}`;
          const jobContext = {
            jobRequestId,
            contentId: msg.body.id,
            userId: msg.body.userId,
            category: msg.body.category,
            operation: 'embedBatch',
          };

          const timer = metrics.startTimer('process_job');

          let job!: SiloContentItem;
          try {
            await trackOperation(
              'process_content_job',
              async () => {
                const { silo, preprocessor, embedder, vectorize } = this.services;

                job = await silo.get(msg.body.id, msg.body.userId);
                assertExists(job, `Content not found in Silo for ID: ${msg.body.id}`, jobContext);

                if (job.body === undefined) {
                  logger.error(
                    { ...jobContext, contentSize: 0 },
                    'Empty job body, skipping embedding',
                  );
                  return;
                }

                const jobText = job.body || '';
                const truncatedText =
                  jobText.length > MAX_TEXT_LENGTH
                    ? jobText.substring(0, MAX_TEXT_LENGTH)
                    : jobText;

                if (truncatedText.length < jobText.length) {
                  logger.warn(
                    {
                      ...jobContext,
                      originalLength: jobText.length,
                      truncatedLength: truncatedText.length,
                    },
                    'Text truncated to prevent memory issues',
                  );

                  metrics.counter('content.truncated', 1);
                }

                const chunks = preprocessor.process(truncatedText);

                if (chunks.length === 0) {
                  logger.warn(
                    { ...jobContext, textLength: truncatedText.length },
                    'No processable text found in content',
                  );
                  metrics.counter('preprocessing.empty_result', 1);
                  return;
                }

                logger.info(
                  { ...jobContext, chunks: chunks.length, textLength: truncatedText.length },
                  `Successfully preprocessed content into ${chunks.length} chunks`,
                );

                metrics.counter('preprocessing.success', 1);
                metrics.gauge('preprocessing.chunk_count', chunks.length);


                const allVectors = await this.embedChunks(chunks, job, jobContext);
                await this.upsertVectors(allVectors, jobContext);

                logger.info(
                  {
                    ...jobContext,
                    vectorCount: allVectors.length,
                    textLength: truncatedText.length,
                    duration: Date.now() - startTime,
                  },
                  `Successfully upserted ${allVectors.length} vectors for content`,
                );

                metrics.trackOperation('content_embedding', true, {
                  requestId: jobRequestId,
                  vectorCount: String(allVectors.length),
                });

                processed += 1;

                chunks.length = 0;
                allVectors.length = 0;
              },
              jobContext,
            );
          } catch (err) {
            const domeError = toDomeError(err, `Failed to embed content ID: ${msg.body.id}`, {
              ...jobContext,
            });

            logError(domeError, `Content embedding failed for ID: ${msg.body.id}`);
            metrics.trackOperation('content_embedding', false, {
              requestId: jobRequestId,
              errorType: domeError.code,
            });

            await sendToDeadLetter(
              deadQueue,
              {
                err: domeError.message,
                errorCode: domeError.code,
                job: job!,
                timestamp: Date.now(),
              },
              jobRequestId,
            );
          } finally {
            timer.stop();
          }

          if (messages.indexOf(msg) < messages.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }

        this.logBatchResults(batchRequestId, processed, messages.length, startTime);
        return processed;
      },
      { jobCount: messages.length, batchRequestId },
    );
  }

  private async embedChunks(
    chunks: string[],
    job: SiloContentItem,
    jobContext: Record<string, unknown>,
  ): Promise<{ id: string; values: number[]; metadata: VectorMeta }[]> {
    const MAX_CHUNKS_PER_BATCH = 50;
    const { embedder } = this.services;
    let vectors: { id: string; values: number[]; metadata: VectorMeta }[] = [];

    for (let i = 0; i < chunks.length; i += MAX_CHUNKS_PER_BATCH) {
      const batchChunks = chunks.slice(i, i + MAX_CHUNKS_PER_BATCH);
      const chunkBatchIndex = Math.floor(i / MAX_CHUNKS_PER_BATCH) + 1;
      const totalChunkBatches = Math.ceil(chunks.length / MAX_CHUNKS_PER_BATCH);

      logger.debug(
        {
          ...jobContext,
          chunkBatchIndex,
          totalChunkBatches,
          batchSize: batchChunks.length,
        },
        `Processing chunk batch ${chunkBatchIndex}/${totalChunkBatches}`,
      );

      try {
        const batchVectors = (await embedder.embed(batchChunks)).map((v, idx) => ({
          id: `content:${job.id}:${i + idx}`,
          values: v,
          metadata: <VectorMeta>{
            userId: job.userId,
            contentId: job.id,
            category: job.category,
            mimeType: job.mimeType,
            createdAt: Math.floor(job.createdAt / 1000),
            version: 1,
          },
        }));

        vectors = vectors.concat(batchVectors);

        logger.debug(
          { ...jobContext, chunkBatchIndex, vectorCount: batchVectors.length },
          `Successfully embedded chunk batch ${chunkBatchIndex}/${totalChunkBatches}`,
        );

        metrics.counter('embedding.batch_success', 1);
        metrics.counter('embedding.vectors_created', batchVectors.length);

        batchChunks.length = 0;

        if (i + MAX_CHUNKS_PER_BATCH < chunks.length) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      } catch (err) {
        const domeError = new EmbeddingError(
          `Failed to embed chunk batch ${chunkBatchIndex}/${totalChunkBatches}`,
          {
            ...jobContext,
            chunkBatchIndex,
            totalChunkBatches,
            batchSize: batchChunks.length,
          },
          err instanceof Error ? err : undefined,
        );

        logError(domeError, `Embedding chunk batch ${chunkBatchIndex} failed`);
        metrics.counter('embedding.batch_errors', 1);

        throw domeError;
      }
    }

    return vectors;
  }

  private async upsertVectors(
    vectors: { id: string; values: number[]; metadata: VectorMeta }[],
    jobContext: Record<string, unknown>,
  ) {
    const UPSERT_BATCH_SIZE = 100;
    const { vectorize } = this.services;

    for (let i = 0; i < vectors.length; i += UPSERT_BATCH_SIZE) {
      const upsertBatch = vectors.slice(i, i + UPSERT_BATCH_SIZE);
      const upsertBatchIndex = Math.floor(i / UPSERT_BATCH_SIZE) + 1;
      const totalUpsertBatches = Math.ceil(vectors.length / UPSERT_BATCH_SIZE);

      logger.debug(
        {
          ...jobContext,
          upsertBatchIndex,
          totalUpsertBatches,
          batchSize: upsertBatch.length,
        },
        `Upserting vector batch ${upsertBatchIndex}/${totalUpsertBatches}`,
      );

      try {
        await vectorize.upsert(upsertBatch);

        logger.debug(
          { ...jobContext, upsertBatchIndex, totalUpsertBatches },
          `Successfully upserted batch ${upsertBatchIndex}/${totalUpsertBatches}`,
        );

        metrics.counter('vectorize.batch_success', 1);
      } catch (err) {
        const domeError = new VectorizeError(
          `Failed to upsert batch ${upsertBatchIndex}/${totalUpsertBatches}`,
          { ...jobContext, upsertBatchIndex, totalUpsertBatches },
          err instanceof Error ? err : undefined,
        );

        logError(domeError, `Vector upsert batch ${upsertBatchIndex} failed`);
        metrics.counter('vectorize.batch_errors', 1);

        throw domeError;
      }
    }
  }

  private logBatchResults(
    batchRequestId: string,
    processed: number,
    jobCount: number,
    startTime: number,
  ) {
    const duration = Date.now() - startTime;

    logger.info(
      {
        batchRequestId,
        jobCount,
        processedCount: processed,
        successRate: Math.round((processed / jobCount) * 100),
        duration,
        operation: 'embedBatch',
      },
      `Completed embedding batch: ${processed}/${jobCount} jobs successful`,
    );

    metrics.gauge('batch.success_rate', processed / jobCount);
    metrics.timing('batch.duration_ms', duration);
    metrics.gauge('batch.avg_job_time_ms', jobCount > 0 ? duration / jobCount : 0);
  }
  /* ---------------------------- queue consumer -------------------------- */

  /**
   * Queue handler for processing message batches
   * @param batch Batch of messages to process
   */
  async queue(batch: MessageBatch<Record<string, unknown>>) {
    const batchId = crypto.randomUUID();

    await runWithLog(
      {
        service: 'constellation',
        op: 'queue',
        size: batch.messages.length,
        batchRequestId: batchId,
        ...this.env,
      },
      async () => {
        const startTime = Date.now();
        metrics.gauge('queue.batch_size', batch.messages.length);
        metrics.counter('queue.batches_received', 1);

        let parsed: ParsedMessageBatch<NewContentMessage>;
        try {
          parsed = parseMessageBatch(
            NewContentMessageSchema,
            batch as unknown as RawMessageBatch,
          );
        } catch (err) {
          const domeError = toDomeError(err, 'Failed to parse message batch', {
            batchId,
            queueName: batch.queue,
          });
          logError(domeError, 'Invalid queue batch');
          metrics.counter('queue.parse_errors', 1);
          throw domeError;
        }

        logger.info(
          {
            batchRequestId: batchId,
            messageCount: parsed.messages.length,
            queueName: batch.queue,
            operation: 'queue',
          },
          `Processing queue batch with ${parsed.messages.length} messages`,
        );

        if (parsed.messages.length) {
          const processed = await this.embedBatch(
            parsed.messages,
            this.env.EMBED_DEAD,
            batchId,
          );
          metrics.counter('queue.jobs_processed', processed);
        }

        const duration = Date.now() - startTime;
        metrics.timing('queue.batch_processing_time', duration);
        metrics.counter('queue.batches_completed', 1);
      },
    );
  }
  /* ---------------------------- rpc: embed ------------------------------ */

  /**
   * RPC method to embed a specific content item
   * @param job Content item to embed
   */
  public async embed(job: SiloContentItem) {
    const requestId = crypto.randomUUID();

    await runWithLog(
      {
        service: 'constellation',
        op: 'embed',
        content: job.id,
        user: job.userId,
        requestId,
        ...this.env,
      },
      async () => {
        try {
          // Validate job data
          assertValid(!!job, 'Content item is required', { requestId });
          assertValid(!!job.id, 'Content ID is required', {
            requestId,
            operation: 'embed',
          });

          // Track request metrics
          metrics.counter('rpc.embed.requests', 1);

          logger.info(
            {
              contentId: job.id,
              userId: job.userId,
              contentType: job.category || job.mimeType || 'unknown',
              requestId,
              operation: 'embed',
            },
            'Processing RPC embed request',
          );

          const msg: ParsedQueueMessage<NewContentMessage> = {
            id: job.id,
            timestamp: Date.now(),
            body: {
              id: job.id,
              userId: job.userId,
              category: job.category,
              mimeType: job.mimeType,
              createdAt: job.createdAt,
            },
          };

          const processed = await this.embedBatch([msg], undefined, requestId);

          // Track success metrics
          metrics.counter('rpc.embed.success', 1);
          metrics.trackOperation('rpc_embed', true, {
            requestId,
            contentId: job.id,
          });

          logger.info(
            {
              contentId: job.id,
              processed,
              success: processed === 1,
              requestId,
              operation: 'embed',
            },
            `RPC embed request ${processed === 1 ? 'succeeded' : 'failed'}`,
          );
        } catch (error) {
          // Track failure metrics
          metrics.counter('rpc.embed.errors', 1);

          const domeError = toDomeError(error, `Failed to embed content ID: ${job.id}`, {
            contentId: job.id,
            userId: job.userId,
            requestId,
            operation: 'embed',
          });

          logError(domeError, 'RPC embed request failed');

          metrics.trackOperation('rpc_embed', false, {
            requestId,
            contentId: job.id,
            errorType: domeError.code,
          });

          throw domeError;
        }
      },
    );
  }

  /* ---------------------------- rpc: query ------------------------------ */

  /**
   * RPC method to query for similar vectors
   * @param text Text to search for
   * @param filter Metadata filters to apply
   * @param topK Number of results to return
   * @returns Search results or error object
   */
  public async query(
    text: string,
    filter: Partial<VectorMeta>,
    topK = 10,
  ): Promise<VectorSearchResult[] | { error: unknown }> {
    const requestId = crypto.randomUUID();

    return runWithLog(
      {
        service: 'constellation',
        op: 'query',
        filter,
        topK,
        requestId,
        ...this.env,
      },
      async () => {
        try {
          // Validate inputs
          assertValid(typeof text === 'string', 'Text query is required', { requestId });
          assertValid(text.trim().length > 0, 'Query text cannot be empty', { requestId });
          assertValid(topK > 0 && topK <= 1000, 'topK must be between 1 and 1000', {
            requestId,
            providedTopK: topK,
          });

          // Track query metrics
          metrics.counter('rpc.query.requests', 1);
          metrics.gauge('rpc.query.text_length', text.length);

          logger.info(
            {
              query: text,
              filterKeys: Object.keys(filter),
              topK,
              requestId,
              operation: 'query',
            },
            'Processing vector search query',
          );

          const { preprocessor, embedder, vectorize } = this.services;

          // Preprocess the query
          const norm = preprocessor.normalize(text);

          if (!norm) {
            logger.warn(
              { requestId, operation: 'query' },
              'Normalization produced empty text, returning empty results',
            );

            metrics.counter('rpc.query.empty_norm', 1);
            return [];
          }

          logger.debug(
            {
              requestId,
              originalLength: text.length,
              normalizedLength: norm.length,
              operation: 'query',
            },
            'Successfully normalized query text',
          );

          // Generate embedding
          const [queryVec] = await embedder.embed([norm]);

          logger.debug(
            {
              requestId,
              vectorLength: queryVec.length,
              operation: 'query',
            },
            'Generated embedding vector for query',
          );

          // Query for similar vectors
          const results = await vectorize.query(queryVec, filter, topK);

          // Log summarized results
          logger.info(
            {
              requestId,
              resultCount: results.length,
              topScore: results.length > 0 ? results[0].score : 0,
              operation: 'query',
            },
            `Query returned ${results.length} results`,
          );

          // Track success metrics
          metrics.counter('rpc.query.success', 1);
          metrics.gauge('rpc.query.results', results.length);
          metrics.trackOperation('vector_query', true, {
            requestId,
            resultCount: String(results.length),
          });

          return results;
        } catch (error) {
          // Track error metrics
          metrics.counter('rpc.query.errors', 1);

          const domeError = toDomeError(error, 'Vector query failed', {
            requestId,
            operation: 'query',
            textLength: text?.length,
            filterKeys: Object.keys(filter || {}),
          });

          logError(domeError, 'Vector query operation failed');

          metrics.trackOperation('vector_query', false, {
            requestId,
            errorType: domeError.code,
          });

          // Return structured error object for RPC
          return {
            error: {
              message: domeError.message,
              code: domeError.code,
              status: domeError.statusCode,
            },
          };
        }
      },
    );
  }

  /* ---------------------------- rpc: stats ------------------------------ */

  /**
   * RPC method to get vector index statistics
   * @returns Index statistics or error object
   */
  public async stats() {
    const requestId = crypto.randomUUID();

    return runWithLog(
      {
        service: 'constellation',
        op: 'stats',
        requestId,
        ...this.env,
      },
      async () => {
        try {
          // Track stats request
          metrics.counter('rpc.stats.requests', 1);

          logger.info({ requestId, operation: 'stats' }, 'Fetching vector index statistics');

          // Get stats from vectorize service
          const stats = await this.services.vectorize.getStats();

          // Track success
          metrics.counter('rpc.stats.success', 1);

          logger.info(
            {
              requestId,
              vectors: stats.vectors,
              dimension: stats.dimension,
              operation: 'stats',
            },
            'Successfully retrieved vector index statistics',
          );

          return stats;
        } catch (error) {
          // Track error
          metrics.counter('rpc.stats.errors', 1);

          const domeError = toDomeError(error, 'Failed to retrieve vector index statistics', {
            requestId,
            operation: 'stats',
          });

          logError(domeError, 'Error getting vector index stats');

          // Return structured error for RPC
          return {
            error: {
              message: domeError.message,
              code: domeError.code,
              status: domeError.statusCode,
            },
          };
        }
      },
    );
  }
}
export { sendToDeadLetter };
