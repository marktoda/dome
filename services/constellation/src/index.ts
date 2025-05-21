import { BaseWorker } from '@dome/common';
import {
  VectorMeta,
  VectorSearchResult,
  ParsedQueueMessage,
  ParsedMessageBatch,
  NewContentMessage,
  SiloContentItem,
} from '@dome/common';


import {
  getLogger,
  logError,
  trackOperation,
  constellationMetrics as metrics,
} from './utils/logging';
import {
  toDomeError,
  VectorizeError,
  EmbeddingError,
} from './utils/errors';
import {
  domeAssertExists as assertExists,
} from '@dome/common/errors';
import { createPreprocessor } from './services/preprocessor';
import { createEmbedder } from './services/embedder';
import { createVectorizeService } from './services/vectorize';
import { SiloClient, SiloBinding } from '@dome/silo/client';
import { Queue } from '@cloudflare/workers-types/experimental';
import { DeadLetterQueue } from './queues/DeadLetterQueue';
import { NewContentQueue } from '@dome/silo/queues';
import * as rpcHandlers from './handlers/rpc';
import * as queueHandlers from './handlers/queues';

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
 * Helper to run service logic with standardized context and error handling.
 */

/**
 * Send a failed message to the dead letter queue with enhanced error context
 * @param queue Dead letter queue
 * @param payload Payload to send to dead letter queue
 * @param requestId Request ID for correlation
 */
const sendToDeadLetter = async (
  queue: Queue,
  payload: {
    err?: Error | string;
    job?: SiloContentItem;
    error?: string;
    originalMessage?: unknown;
    errorCode?: string;
    timestamp?: number;
  },
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

  // Validate the payload format
  if (!('err' in payload || 'error' in payload)) {
    throw new Error(`Invalid payload format for sendToDeadLetter: ${JSON.stringify(payload)}`);
  }

  return trackOperation(
    'send_to_dlq',
    async () => {
      logger.info(
        {
          requestId,
          operation: 'sendToDeadLetter',
          contentId: payload.job?.id || (payload.originalMessage as any)?.id,
        },
        'Sending message to dead letter queue',
      );

      // Support both formats: { err, job } and { error, originalMessage }
      const message = payload.error !== undefined
        ? { error: payload.error, originalMessage: payload.originalMessage }
        : {
            error: payload.err instanceof Error
              ? payload.err.message
              : typeof payload.err === 'string'
                ? payload.err
                : 'Unknown error',
            originalMessage: payload.job
          };

      // Create a typed queue wrapper
      const deadLetterQueue = new DeadLetterQueue(queue);
      await deadLetterQueue.send(message);

      metrics.counter('dlq.messages_sent', 1);

      logger.info(
        { requestId, operation: 'sendToDeadLetter' },
        'Successfully sent message to dead letter queue',
      );
    },
    { requestId },
  );
};

/* -------------------------------------------------------------------------- */
/* worker                                                                     */
/* -------------------------------------------------------------------------- */

export default class Constellation extends BaseWorker<ServiceEnv, ReturnType<typeof buildServices>> {
  constructor(ctx: ExecutionContext, env: ServiceEnv) {
    super(ctx, env, buildServices, { serviceName: 'constellation' });
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

            if (deadQueue) {
              await sendToDeadLetter(
                deadQueue,
                {
                  err: domeError,
                  job: job!,
                },
                jobRequestId,
              );
            }
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

      await vectorize.upsert(upsertBatch);

      logger.debug(
        { ...jobContext, upsertBatchIndex, totalUpsertBatches },
        `Successfully upserted batch ${upsertBatchIndex}/${totalUpsertBatches}`,
      );

      metrics.counter('vectorize.batch_success', 1);
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
    await queueHandlers.handleQueue.call(this, batch);
  }
  /* ---------------------------- rpc: embed ------------------------------ */

  /**
   * RPC method to embed a specific content item
   * @param job Content item to embed
   */
  public async embed(job: SiloContentItem) {
    await rpcHandlers.embed.call(this, job);
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
    return rpcHandlers.query.call(this, text, filter, topK);
  }

  /* ---------------------------- rpc: stats ------------------------------ */

  /**
   * RPC method to get vector index statistics
   * @returns Index statistics or error object
   */
  public async stats() {
    return rpcHandlers.stats.call(this);
  }
}
export { sendToDeadLetter };
