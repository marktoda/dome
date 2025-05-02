import { WorkerEntrypoint } from 'cloudflare:workers';
import { withLogger, metrics } from '@dome/logging';
import { toDomeError } from '@dome/errors';
import { createLlmService } from './services/llmService';
import { EnrichedContentMessage, NewContentMessage, SiloContentMetadata } from '@dome/common';
import { SiloClient, SiloBinding } from '@dome/silo/client';
import { z } from 'zod';
import { sendTodosToQueue } from './todos';
import {
  getLogger,
  logError,
  trackOperation,
  sanitizeForLogging,
  aiProcessorMetrics
} from './utils/logging';
import {
  assertValid,
  assertExists,
  LLMProcessingError,
  ContentProcessingError,
  QueueError
} from './utils/errors';

/**
 * Build service dependencies
 * @param env Environment bindings
 * @returns Service instances
 */
const buildServices = (env: Env) => ({
  llm: createLlmService(env),
  silo: new SiloClient(env.SILO as unknown as SiloBinding),
});

/**
 * Run a function with enhanced logging and error handling
 * @param meta Metadata for logging context
 * @param fn Function to execute
 * @returns Result of the function
 */
const runWithLog = <T>(meta: Record<string, unknown>, fn: () => Promise<T>): Promise<T> =>
  withLogger(meta, async () => {
    try {
      return await fn();
    } catch (err) {
      const requestId = typeof meta.requestId === 'string' ? meta.requestId : undefined;
      const operation = typeof meta.op === 'string' ? meta.op : 'unknown_operation';

      const errorContext = {
        operation,
        requestId,
        service: 'ai-processor',
        timestamp: new Date().toISOString(),
        ...meta
      };

      logError(err, `Unhandled error in ${operation}`, errorContext);

      // Convert to a proper DomeError before rethrowing
      throw toDomeError(err, `Error in ${operation}`, errorContext);
    }
  });

// Define the schema for reprocess requests
export const ReprocessRequestSchema = z.object({
  id: z.string().optional(),
});

// Define the schema for reprocess responses
export const ReprocessResponseSchema = z.object({
  success: z.boolean(),
  reprocessed: z.union([
    z.object({
      id: z.string(),
      success: z.boolean(),
    }),
    z.object({
      total: z.number(),
      successful: z.number(),
    }),
  ]),
});

/**
 * AI Processor Worker
 *
 * This worker processes content from the NEW_CONTENT queue,
 * extracts metadata using LLM, and publishes results to the
 * ENRICHED_CONTENT queue.
 *
 * It also provides RPC functions for reprocessing content.
 */
export default class AiProcessor extends WorkerEntrypoint<Env> {
  /** Lazily created bundle of service clients (re‑used for every call) */
  private _services?: ReturnType<typeof buildServices>;
  private get services() {
    return (this._services ??= buildServices(this.env));
  }

  /**
   * RPC function to reprocess content
   * @param data Request data with optional ID
   * @returns Result of reprocessing
   */
  async reprocess(data: z.infer<typeof ReprocessRequestSchema>) {
    const requestId = crypto.randomUUID();

    return trackOperation(
      'reprocess_content',
      async () => {
        try {
          // Validate input
          const validatedData = ReprocessRequestSchema.parse(data);
          const { id } = validatedData;

          if (id) {
            // Reprocess specific content by ID
            getLogger().info({
              requestId,
              id,
              operation: 'reprocess_content'
            }, 'Reprocessing specific content by ID');

            const result = await this.reprocessById(id, requestId);

            aiProcessorMetrics.trackOperation('reprocess', true, {
              type: 'by_id',
              requestId
            });

            return { success: true, reprocessed: result };
          } else {
            // Reprocess all content with null or "Content processing failed" summary
            getLogger().info({
              requestId,
              operation: 'reprocess_content_batch'
            }, 'Reprocessing all content with null or failed summary');

            const result = await this.reprocessFailedContent(requestId);

            aiProcessorMetrics.trackOperation('reprocess', true, {
              type: 'all_failed',
              requestId,
              totalItems: String(result.total),
              successfulItems: String(result.successful)
            });

            return { success: true, reprocessed: result };
          }
        } catch (error) {
          const domeError = toDomeError(error, 'Error in reprocess operation', {
            service: 'ai-processor',
            operation: 'reprocess',
            id: data.id,
            requestId
          });

          logError(domeError, 'Failed to reprocess content');

          aiProcessorMetrics.trackOperation('reprocess', false, {
            errorType: domeError.code,
            requestId
          });

          throw domeError;
        }
      },
      { requestId, id: data.id }
    );
  }

  /**
   * Reprocess content by ID
   * @param id Content ID to reprocess
   * @returns Result of reprocessing
   */
  /**
   * Reprocess content by ID
   * @param id Content ID to reprocess
   * @param requestId Request ID for correlation
   * @returns Result of reprocessing
   */
  private async reprocessById(id: string, requestId: string): Promise<{ id: string; success: boolean }> {
    return trackOperation(
      'reprocess_by_id',
      async () => {
        try {
          // Get content metadata from Silo
          const metadata = await this.services.silo.getMetadataById(id);

          // Validate content exists
          assertExists(metadata, `Content with ID ${id} not found`, {
            id,
            operation: 'reprocessById',
            requestId
          });

          // Create a new content message and process it
          // Since we used assertExists, TypeScript should know metadata is not null
          // But we'll add a non-null assertion to make it explicit
          const message: NewContentMessage = {
            id: metadata!.id,
            userId: metadata!.userId,
            category: metadata!.category,
            mimeType: metadata!.mimeType,
          };

          await this.processMessage(message, requestId);

          aiProcessorMetrics.trackOperation('reprocess_by_id', true, {
            id,
            requestId,
            contentType: metadata!.category || metadata!.mimeType || 'unknown'
          });

          return { id, success: true };
        } catch (error) {
          const domeError = toDomeError(error, `Error reprocessing content with ID ${id}`, {
            id,
            operation: 'reprocessById',
            requestId
          });

          logError(domeError, `Failed to reprocess content ID: ${id}`);

          aiProcessorMetrics.trackOperation('reprocess_by_id', false, {
            id,
            requestId,
            errorType: domeError.code
          });

          return { id, success: false };
        }
      },
      { id, requestId }
    );
  }

  /**
   * Reprocess all content with null or "Content processing failed" summary
   * @returns Result of reprocessing
   */
  /**
   * Reprocess all content with failed summaries
   * @param requestId Request ID for correlation
   * @returns Result statistics
   */
  private async reprocessFailedContent(requestId: string): Promise<{ total: number; successful: number }> {
    return trackOperation(
      'reprocess_failed_content',
      async () => {
        try {
          // Get all content with null or "Content processing failed" summary
          const failedContent = await this.services.silo.findContentWithFailedSummary();

          getLogger().info({
            count: failedContent.length,
            requestId,
            operation: 'reprocessFailedContent'
          }, 'Found content with failed summaries');

          let successful = 0;
          let errors = 0;

          // Process each failed content
          for (const content of failedContent) {
            try {
              const message: NewContentMessage = {
                id: content.id,
                userId: content.userId,
                category: content.category,
                mimeType: content.mimeType,
              };

              await this.processMessage(message, requestId);
              successful++;

              // Log progress periodically for long-running batch operations
              if (successful % 10 === 0) {
                getLogger().info({
                  requestId,
                  progress: `${successful}/${failedContent.length}`,
                  percentComplete: Math.round((successful / failedContent.length) * 100),
                  operation: 'reprocessFailedContent'
                }, 'Batch reprocessing progress');
              }
            } catch (error) {
              errors++;
              const domeError = toDomeError(error, `Error reprocessing content ID: ${content.id}`, {
                id: content.id,
                requestId,
                operation: 'reprocessFailedContent'
              });

              logError(domeError, `Failed to reprocess content during batch operation`);
            }
          }

          aiProcessorMetrics.trackOperation('reprocess_batch', true, {
            totalItems: String(failedContent.length),
            successfulItems: String(successful),
            failedItems: String(errors),
            requestId
          });

          getLogger().info({
            total: failedContent.length,
            successful,
            errors,
            requestId,
            successRate: failedContent.length > 0
              ? Math.round((successful / failedContent.length) * 100)
              : 0,
            operation: 'reprocessFailedContent'
          }, 'Completed batch reprocessing of failed content');

          return { total: failedContent.length, successful };
        } catch (error) {
          const domeError = toDomeError(error, 'Error reprocessing failed content batch', {
            requestId,
            operation: 'reprocessFailedContent'
          });

          logError(domeError, 'Failed to reprocess content batch');

          aiProcessorMetrics.trackOperation('reprocess_batch', false, {
            errorType: domeError.code,
            requestId
          });

          return { total: 0, successful: 0 };
        }
      },
      { requestId }
    );
  }

  /**
   * Queue handler for processing messages
   * @param batch Batch of messages from the queue
   * @param env Environment bindings
   */
  /**
   * Queue handler for processing batches of messages
   * @param batch Batch of messages from the queue
   */
  async queue(batch: MessageBatch<NewContentMessage>) {
    const batchId = crypto.randomUUID();

    await trackOperation(
      'process_message_batch',
      async () => {
        const startTime = Date.now();
        const queueName = batch.queue;

        getLogger().info(
          {
            queueName,
            batchId,
            messageCount: batch.messages.length,
            firstMessageId: batch.messages[0]?.id,
            operation: 'queue'
          },
          'Processing queue batch',
        );

        // Track batch metrics
        aiProcessorMetrics.counter('batch.received', 1, { queueName });
        aiProcessorMetrics.counter('messages.received', batch.messages.length, { queueName });

        let successCount = 0;
        let errorCount = 0;

        // Process each message in the batch
        for (const message of batch.messages) {
          const messageRequestId = `${batchId}-${message.id}`;
          try {
            assertValid(!!message.body, 'Message body is empty or invalid', {
              messageId: message.id,
              batchId
            });

            await this.processMessage(message.body, messageRequestId);
            successCount++;
          } catch (error) {
            errorCount++;
            const domeError = toDomeError(error, 'Failed to process queue message', {
              messageId: message.id,
              contentId: message.body?.id,
              batchId,
              requestId: messageRequestId
            });

            logError(domeError, 'Failed to process message from queue');
            aiProcessorMetrics.counter('messages.errors', 1, {
              queueName,
              errorType: domeError.code
            });
          }
        }

        // Log batch completion with detailed statistics
        const duration = Date.now() - startTime;
        getLogger().info(
          {
            queueName,
            batchId,
            messageCount: batch.messages.length,
            successCount,
            errorCount,
            successRate: Math.round((successCount / batch.messages.length) * 100),
            durationMs: duration,
            avgProcessingTimeMs: Math.round(duration / batch.messages.length),
            operation: 'queue'
          },
          'Completed processing queue batch',
        );

        // Track detailed batch metrics
        aiProcessorMetrics.timing('batch.duration_ms', duration, { queueName });
        aiProcessorMetrics.counter('batch.completed', 1, { queueName });
        aiProcessorMetrics.counter('messages.processed', successCount, { queueName });
        aiProcessorMetrics.gauge('batch.success_rate', successCount / batch.messages.length, { queueName });
      },
      { batchId, queueName: batch.queue, messageCount: batch.messages.length }
    );
  }

  /**
   * Process a single message from the queue
   * @param message Message from the queue
   * @param env Environment bindings
   * @param llmService LLM service for processing content
   * @param siloService Silo service for fetching content
   */
  /**
   * Process a single content message
   * @param message The message to process
   * @param requestId Request ID for correlation
   */
  async processMessage(message: NewContentMessage, requestId: string = crypto.randomUUID()) {
    return trackOperation(
      'process_content_message',
      async () => {
        const { id, userId, category, mimeType, deleted } = message;

        // Use category as contentType, fallback to mimeType or 'note'
        const contentType = category || mimeType || 'note';

        // Skip deleted content
        if (deleted) {
          getLogger().info({
            id,
            userId,
            requestId,
            operation: 'processMessage'
          }, 'Skipping deleted content');
          return;
        }

        // Skip non-text content types if needed
        if (!isProcessableContentType(contentType)) {
          getLogger().info(
            {
              id,
              userId,
              contentType,
              category,
              mimeType,
              requestId,
              operation: 'processMessage'
            },
            'Skipping non-processable content type',
          );
          return;
        }

        try {
          getLogger().info({
            id,
            userId,
            contentType,
            requestId,
            operation: 'processMessage'
          }, 'Processing content');

          // Fetch content from Silo
          const content = await this.services.silo.get(id, userId);
          assertExists(content, `Content not found for ID: ${id}`, {
            id,
            userId,
            requestId
          });

          const { body } = content;

          // Skip empty content
          if (!body || body.trim().length === 0) {
            getLogger().info({
              id,
              userId,
              requestId,
              operation: 'processMessage'
            }, 'Skipping empty content');
            return;
          }

          // Process with LLM - track as a sub-operation
          const metadata = await trackOperation(
            'llm_process_content',
            () => this.services.llm.processContent(body, contentType),
            { id, userId, contentType, requestId }
          );
          getLogger().info({ metadata }, 'LLM processing completed');

          // Publish to ENRICHED_CONTENT queue
          const enrichedMessage: EnrichedContentMessage = {
            id,
            userId,
            category: category as any, // Using category from the message
            mimeType: mimeType as any, // Using mimeType from the message
            metadata,
            timestamp: Date.now(),
          };

          if ('ENRICHED_CONTENT' in this.env) {
            await trackOperation(
              'publish_enriched_message',
              () => (this.env as any).ENRICHED_CONTENT.send(enrichedMessage),
              { id, userId, requestId }
            );
          }

          // Send todos to the dedicated todos queue if they exist and the queue binding is available
          if ('TODOS' in this.env &&
            enrichedMessage.metadata.todos &&
            Array.isArray(enrichedMessage.metadata.todos) &&
            enrichedMessage.metadata.todos.length > 0 &&
            userId) { // Ensure userId is defined and not null

            await sendTodosToQueue(
              enrichedMessage,
              (this.env as any).TODOS
            );
          }

          // Log successful processing with sanitized data
          const sanitizedMessage = sanitizeForLogging({
            id,
            hasSummary: !!metadata.summary,
            summaryLength: metadata.summary ? metadata.summary.length : 0,
            hasTodos: Array.isArray(metadata.todos) && metadata.todos.length > 0,
            todoCount: Array.isArray(metadata.todos) ? metadata.todos.length : 0,
            hasTopics: Array.isArray(metadata.topics) && metadata.topics.length > 0,
            topicCount: Array.isArray(metadata.topics) ? metadata.topics.length : 0,
          });

          getLogger().info(
            {
              ...sanitizedMessage,
              requestId,
              operation: 'processMessage'
            },
            'Successfully processed and published enriched content',
          );

          // Track successful processing with detailed metrics
          aiProcessorMetrics.counter('messages.processed', 1, {
            contentType,
            hasSummary: !!metadata.summary ? 'true' : 'false',
            hasTodos: Array.isArray(metadata.todos) && metadata.todos.length > 0 ? 'true' : 'false'
          });

          aiProcessorMetrics.trackOperation('process_message', true, {
            contentType,
            requestId
          });
        } catch (error) {
          // Convert to appropriate domain error
          const errorContext = {
            id,
            userId,
            category,
            mimeType,
            contentType,
            operation: 'processMessage',
            requestId,
            timestamp: new Date().toISOString()
          };

          let domeError;
          if (error instanceof Error && error.message.includes('LLM')) {
            domeError = new LLMProcessingError(`LLM processing failed for content ID: ${id}`, errorContext, error);
          } else if (error instanceof Error && error.message.includes('Silo')) {
            domeError = new ContentProcessingError(`Content retrieval failed for ID: ${id}`, errorContext, error);
          } else {
            domeError = toDomeError(error, `Error processing content ID: ${id}`, errorContext);
          }

          logError(domeError, `Failed to process content ID: ${id}`);

          // Track specific error types for monitoring
          aiProcessorMetrics.counter('messages.errors', 1, {
            errorType: domeError.code,
            contentType
          });

          aiProcessorMetrics.trackOperation('process_message', false, {
            contentType,
            errorType: domeError.code,
            requestId
          });

          // Re-throw to allow queue retry mechanism to work
          throw domeError;
        }
      },
      { id: message.id, userId: message.userId, requestId }
    );
  }
}

/**
 * Check if a content type is processable by the LLM
 * @param contentType Content type to check
 * @returns True if the content type is processable
 */
function isProcessableContentType(contentType: string): boolean {
  // const processableTypes = ['note', 'code', 'article', 'text/plain', 'text/markdown', 'application/javascript', 'application/typescript', 'application/rust'];
  // return processableTypes.includes(contentType);
  return true;
}
