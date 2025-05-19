import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  VectorMeta,
  VectorSearchResult,
  NewContentMessageSchema,
  SiloContentItem,
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
    getLogger().warn(
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
        getLogger().info(
          {
            requestId,
            operation: 'sendToDeadLetter',
            hasError: 'error' in payload,
            contentId: ('job' in payload && payload.job.id) || undefined,
          },
          'Sending message to dead letter queue',
        );

        await queue.send({
          ...payload,
          _meta: {
            timestamp: Date.now(),
            requestId,
            service: 'constellation',
          },
        });

        metrics.counter('dlq.messages_sent', 1);

        getLogger().info(
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
   * @param jobs Array of content items to process
   * @param deadQueue Dead letter queue for failed items
   * @param batchRequestId Request ID for the entire batch
   * @returns Number of successfully processed items
   */
  private async embedBatch(
    jobs: SiloContentItem[],
    deadQueue?: DeadQueue,
    batchRequestId: string = crypto.randomUUID(),
  ): Promise<number> {
    return trackOperation(
      'embed_batch',
      async () => {
        assertValid(Array.isArray(jobs), 'Jobs array is required', { batchRequestId });

        // Constants for processing limits
        const MAX_CHUNKS_PER_BATCH = 50; // Limit chunks processed at once
        const MAX_TEXT_LENGTH = 100000; // Limit text size to prevent memory issues

        let processed = 0;
        const startTime = Date.now();

        // Log batch processing start
        getLogger().info(
          {
            batchRequestId,
            jobCount: jobs.length,
            operation: 'embedBatch',
          },
          `Starting embedding batch with ${jobs.length} jobs`,
        );

        // Process jobs one at a time to avoid memory issues
        for (const job of jobs) {
          const jobRequestId = `${batchRequestId}-${job.id}`;
          const jobContext = {
            jobRequestId,
            contentId: job.id,
            userId: job.userId,
            category: job.category,
            operation: 'embedBatch',
          };

          if (job.body === undefined) {
            getLogger().error(
              { ...jobContext, contentSize: 0 },
              'Empty job body, skipping embedding',
            );
            continue;
          }

          // Track individual job processing
          const timer = metrics.startTimer('process_job');

          try {
            await trackOperation(
              'process_content_job',
              async () => {
                const { preprocessor, embedder, vectorize } = this.services;

                // Validate the job data
                assertValid(!!job.id, 'Job ID is required', jobContext);
                assertValid(!!job.userId, 'User ID is required', jobContext);
                assertValid(job.body !== undefined, 'Job body is required', jobContext);

                // Truncate extremely large texts to prevent memory issues
                // Ensure job.body is a string (not undefined)
                const jobText = job.body || '';
                const truncatedText =
                  jobText.length > MAX_TEXT_LENGTH
                    ? jobText.substring(0, MAX_TEXT_LENGTH)
                    : jobText;

                if (truncatedText.length < jobText.length) {
                  getLogger().warn(
                    {
                      ...jobContext,
                      originalLength: jobText.length,
                      truncatedLength: truncatedText.length,
                    },
                    'Text truncated to prevent memory issues',
                  );

                  metrics.counter('content.truncated', 1);
                }

                // Process the text into chunks
                try {
                  const chunks = preprocessor.process(truncatedText);

                  if (chunks.length === 0) {
                    getLogger().warn(
                      { ...jobContext, textLength: truncatedText.length },
                      'No processable text found in content',
                    );
                    metrics.counter('preprocessing.empty_result', 1);
                    return;
                  }

                  getLogger().info(
                    {
                      ...jobContext,
                      chunks: chunks.length,
                      textLength: truncatedText.length,
                    },
                    `Successfully preprocessed content into ${chunks.length} chunks`,
                  );

                  metrics.counter('preprocessing.success', 1);
                  metrics.gauge('preprocessing.chunk_count', chunks.length);

                  // Process chunks in smaller batches to avoid memory issues
                  let allVectors: { id: string; values: number[]; metadata: VectorMeta }[] = [];

                  // Track embedding progress
                  for (let i = 0; i < chunks.length; i += MAX_CHUNKS_PER_BATCH) {
                    const batchChunks = chunks.slice(i, i + MAX_CHUNKS_PER_BATCH);
                    const chunkBatchIndex = Math.floor(i / MAX_CHUNKS_PER_BATCH) + 1;
                    const totalChunkBatches = Math.ceil(chunks.length / MAX_CHUNKS_PER_BATCH);

                    getLogger().debug(
                      {
                        ...jobContext,
                        chunkBatchIndex,
                        totalChunkBatches,
                        batchSize: batchChunks.length,
                      },
                      `Processing chunk batch ${chunkBatchIndex}/${totalChunkBatches}`,
                    );

                    try {
                      // Generate embeddings for this batch of chunks
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

                      allVectors = allVectors.concat(batchVectors);

                      getLogger().debug(
                        {
                          ...jobContext,
                          chunkBatchIndex,
                          vectorCount: batchVectors.length,
                        },
                        `Successfully embedded chunk batch ${chunkBatchIndex}/${totalChunkBatches}`,
                      );

                      metrics.counter('embedding.batch_success', 1);
                      metrics.counter('embedding.vectors_created', batchVectors.length);

                      // Force garbage collection between batches by breaking reference
                      batchChunks.length = 0;

                      // Add a small delay between batches to allow for garbage collection
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

                  // Upsert vectors in smaller batches
                  const UPSERT_BATCH_SIZE = 100;
                  for (let i = 0; i < allVectors.length; i += UPSERT_BATCH_SIZE) {
                    const upsertBatch = allVectors.slice(i, i + UPSERT_BATCH_SIZE);
                    const upsertBatchIndex = Math.floor(i / UPSERT_BATCH_SIZE) + 1;
                    const totalUpsertBatches = Math.ceil(allVectors.length / UPSERT_BATCH_SIZE);

                    getLogger().debug(
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

                      getLogger().debug(
                        {
                          ...jobContext,
                          upsertBatchIndex,
                          totalUpsertBatches,
                        },
                        `Successfully upserted batch ${upsertBatchIndex}/${totalUpsertBatches}`,
                      );

                      metrics.counter('vectorize.batch_success', 1);
                    } catch (err) {
                      const domeError = new VectorizeError(
                        `Failed to upsert batch ${upsertBatchIndex}/${totalUpsertBatches}`,
                        {
                          ...jobContext,
                          upsertBatchIndex,
                          totalUpsertBatches,
                        },
                        err instanceof Error ? err : undefined,
                      );

                      logError(domeError, `Vector upsert batch ${upsertBatchIndex} failed`);
                      metrics.counter('vectorize.batch_errors', 1);

                      throw domeError;
                    }
                  }

                  getLogger().info(
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

                  // Clear references to large objects to help garbage collection
                  chunks.length = 0;
                  allVectors.length = 0;
                } catch (err) {
                  const domeError = new PreprocessingError(
                    'Failed to preprocess content',
                    { ...jobContext, textLength: truncatedText.length },
                    err instanceof Error ? err : undefined,
                  );

                  logError(domeError, 'Content preprocessing failed');
                  metrics.counter('preprocessing.errors', 1);

                  throw domeError;
                }
              },
              jobContext,
            );
          } catch (err) {
            // Convert to domain error
            const domeError = toDomeError(err, `Failed to embed content ID: ${job.id}`, {
              ...jobContext,
            });

            logError(domeError, `Content embedding failed for ID: ${job.id}`);
            metrics.trackOperation('content_embedding', false, {
              requestId: jobRequestId,
              errorType: domeError.code,
            });

            // Send to dead letter queue with enhanced context
            await sendToDeadLetter(
              deadQueue,
              {
                err: domeError.message,
                errorCode: domeError.code,
                job,
                timestamp: Date.now(),
              },
              jobRequestId,
            );
          } finally {
            timer.stop();
          }

          // Add a delay between jobs to allow for garbage collection
          if (jobs.indexOf(job) < jobs.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }

        // Log batch completion statistics
        const duration = Date.now() - startTime;
        getLogger().info(
          {
            batchRequestId,
            jobCount: jobs.length,
            processedCount: processed,
            successRate: Math.round((processed / jobs.length) * 100),
            duration,
            operation: 'embedBatch',
          },
          `Completed embedding batch: ${processed}/${jobs.length} jobs successful`,
        );

        // Track batch metrics
        metrics.gauge('batch.success_rate', processed / jobs.length);
        metrics.timing('batch.duration_ms', duration);
        metrics.gauge('batch.avg_job_time_ms', jobs.length > 0 ? duration / jobs.length : 0);

        return processed;
      },
      { jobCount: jobs.length, batchRequestId },
    );
  }

  /* ---------------------------- queue consumer -------------------------- */

  /**
   * Queue handler for processing message batches
   * @param batch Batch of messages to process
   */
  async queue(batch: MessageBatch<Record<string, unknown>>) {
    const batchRequestId = crypto.randomUUID();

    await runWithLog(
      {
        service: 'constellation',
        op: 'queue',
        size: batch.messages.length,
        batchRequestId,
        ...this.env,
      },
      async () => {
        // Start tracking queue processing
        const startTime = Date.now();
        metrics.gauge('queue.batch_size', batch.messages.length);
        metrics.counter('queue.batches_received', 1);

        getLogger().info(
          {
            batchRequestId,
            messageCount: batch.messages.length,
            queueName: batch.queue,
            operation: 'queue',
          },
          `Processing queue batch with ${batch.messages.length} messages`,
        );

        const embedItems: SiloContentItem[] = [];
        let parseErrors = 0;

        // Parse each message
        for (const msg of batch.messages) {
          try {
            const item = await this.parseMessage(msg, batchRequestId);
            embedItems.push(item);
          } catch (err) {
            parseErrors++;

            const domeError = toDomeError(err, 'Failed to parse queue message', {
              messageId: msg.id,
              batchRequestId,
              operation: 'parseMessage',
            });

            logError(domeError, 'Error parsing queue message');
            metrics.counter('queue.parse_errors', 1);

            await sendToDeadLetter(
              this.env.EMBED_DEAD,
              {
                error: domeError.message,
                errorCode: domeError.code,
                originalMessage: msg.body,
                timestamp: Date.now(),
              },
              `${batchRequestId}-${msg.id}`,
            );
          }

          // Always acknowledge the message to remove from queue
          msg.ack();
        }

        // Log parsing results
        getLogger().info(
          {
            batchRequestId,
            validMessages: embedItems.length,
            parseErrors,
            parseSuccessRate: Math.round((embedItems.length / batch.messages.length) * 100),
            operation: 'queue',
          },
          `Message parsing complete: ${embedItems.length}/${batch.messages.length} valid`,
        );

        // Process valid messages
        if (embedItems.length) {
          getLogger().info(
            {
              batchRequestId,
              count: embedItems.length,
              operation: 'queue',
            },
            `Processing ${embedItems.length} embed jobs`,
          );

          const processed = await this.embedBatch(embedItems, this.env.EMBED_DEAD, batchRequestId);
          metrics.counter('queue.jobs_processed', processed);

          getLogger().info(
            {
              batchRequestId,
              processed,
              total: embedItems.length,
              successRate: Math.round((processed / embedItems.length) * 100),
              operation: 'queue',
            },
            `Processed ${processed}/${embedItems.length} embed jobs successfully`,
          );
        } else {
          getLogger().warn(
            {
              batchRequestId,
              operation: 'queue',
            },
            'No valid messages to process after parsing',
          );
        }

        // Log batch completion
        const duration = Date.now() - startTime;
        getLogger().info(
          {
            batchRequestId,
            messageCount: batch.messages.length,
            processedCount: embedItems.length,
            successCount: embedItems.length > 0 ? Math.min(embedItems.length, 100) : 0, // Use fixed capacity instead of trying to read gauge value
            duration,
            operation: 'queue',
          },
          'Queue batch processing complete',
        );

        // Track timing metrics
        metrics.timing('queue.batch_processing_time', duration);
        metrics.counter('queue.batches_completed', 1);
      },
    );
  }

  /**
   * Validate and convert a single queue message
   * @param msg Queue message to parse
   * @param requestId Request ID for correlation
   * @returns Parsed SiloContentItem
   */
  private async parseMessage(
    msg: Message<Record<string, unknown>>,
    requestId: string = crypto.randomUUID(),
  ): Promise<SiloContentItem> {
    return trackOperation(
      'parse_message',
      async () => {
        const messageContext = {
          messageId: msg.id,
          requestId,
          operation: 'parseMessage',
        };

        // Validate message has a body
        if (!msg.body) {
          throw new ValidationError('Message body is empty', messageContext);
        }

        // Validate message against schema
        const validation = NewContentMessageSchema.safeParse(msg.body);
        if (!validation.success) {
          const issues = validation.error.issues
            .map(i => `${i.path.join('.')}: ${i.message}`)
            .join(', ');

          getLogger().warn(
            {
              ...messageContext,
              issues,
              messageBody: JSON.stringify(msg.body).substring(0, 200),
            },
            'Invalid message format',
          );

          throw new ValidationError(`Message validation failed: ${issues}`, {
            ...messageContext,
            issues,
          });
        }

        try {
          // Fetch content from Silo
          getLogger().debug(
            {
              ...messageContext,
              contentId: validation.data.id,
              userId: validation.data.userId,
            },
            'Fetching content from Silo',
          );

          // At this point, we know the message body conforms to NewContentMessage schema
          const content = await this.services.silo.get(validation.data.id, validation.data.userId);

          // Verify content was retrieved
          assertExists(content, `Content not found in Silo for ID: ${validation.data.id}`, {
            ...messageContext,
            contentId: validation.data.id,
            userId: validation.data.userId,
          });

          getLogger().debug(
            {
              ...messageContext,
              contentId: content.id,
              contentSize: content.body?.length || 0,
              contentType: content.mimeType || content.category || 'unknown',
            },
            'Successfully fetched content from Silo',
          );

          return content;
        } catch (err) {
          const domeError = toDomeError(err, 'Error fetching content from Silo', {
            ...messageContext,
            contentId: validation.data.id,
            userId: validation.data.userId,
          });

          logError(domeError, 'Silo content retrieval failed');
          throw domeError;
        }
      },
      { messageId: msg.id, requestId },
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

          getLogger().info(
            {
              contentId: job.id,
              userId: job.userId,
              contentType: job.category || job.mimeType || 'unknown',
              requestId,
              operation: 'embed',
            },
            'Processing RPC embed request',
          );

          // Embed the content
          const processed = await this.embedBatch([job], undefined, requestId);

          // Track success metrics
          metrics.counter('rpc.embed.success', 1);
          metrics.trackOperation('rpc_embed', true, {
            requestId,
            contentId: job.id,
          });

          getLogger().info(
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

          getLogger().info(
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
            getLogger().warn(
              { requestId, operation: 'query' },
              'Normalization produced empty text, returning empty results',
            );

            metrics.counter('rpc.query.empty_norm', 1);
            return [];
          }

          getLogger().debug(
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

          getLogger().debug(
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
          getLogger().info(
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

          getLogger().info({ requestId, operation: 'stats' }, 'Fetching vector index statistics');

          // Get stats from vectorize service
          const stats = await this.services.vectorize.getStats();

          // Track success
          metrics.counter('rpc.stats.success', 1);

          getLogger().info(
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
