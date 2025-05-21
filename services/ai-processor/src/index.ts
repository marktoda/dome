/**
 * Silo Service entrypoint
 *
 * This is the main entry point for the Silo service, implementing a WorkerEntrypoint
 * class that handles both RPC methods and queue processing.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { withContext } from '@dome/common';
import { metrics } from '@dome/common';
import { toDomeError } from '@dome/common';
import { createLlmService } from './services/llmService';
import {
  EnrichedContentMessage,
  NewContentMessage,
  ParsedMessageBatch,
} from '@dome/common';
import { NewContentQueue } from '@dome/silo/queues';
import { SiloClient, SiloBinding } from '@dome/silo/client';
import type { ServiceEnv } from './types';
import { z } from 'zod';
import { sendTodosToQueue } from './todos';
import {
  getLogger,
  logError,
  trackOperation,
  sanitizeForLogging,
  aiProcessorMetrics,
} from './utils/logging';
import { ReprocessResponseSchema, ReprocessRequestSchema } from './types';
import { domeAssertExists as assertExists } from '@dome/common/errors';
import { ContentProcessor } from './utils/processor';

/**
 * Build service dependencies
 * @param env Environment bindings
 * @returns Service instances
 */
const buildServices = (env: ServiceEnv) => {
  const first = {
    llm: createLlmService(env),
    silo: new SiloClient(env.SILO),
  };

  return {
    ...first,
    processor: new ContentProcessor(env, first),
  };
};

/**
 * AI Processor Worker
 *
 * This worker processes content from the NEW_CONTENT queue,
 * extracts metadata using LLM, and publishes results to the
 * ENRICHED_CONTENT queue.
 *
 * It also provides RPC functions for reprocessing content.
 */
export default class AiProcessor extends WorkerEntrypoint<ServiceEnv> {
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
            getLogger().info(
              {
                requestId,
                id,
                operation: 'reprocess_content',
              },
              'Reprocessing specific content by ID',
            );

            const result = await this.reprocessById(id, requestId);

            aiProcessorMetrics.trackOperation('reprocess', true, {
              type: 'by_id',
              requestId,
            });

            return { success: true, reprocessed: result };
          } else {
            // Reprocess all content with null or "Content processing failed" summary
            getLogger().info(
              {
                requestId,
                operation: 'reprocess_content_batch',
              },
              'Reprocessing all content with null or failed summary',
            );

            const result = await this.reprocessFailedContent(requestId);

            aiProcessorMetrics.trackOperation('reprocess', true, {
              type: 'all_failed',
              requestId,
              totalItems: String(result.total),
              successfulItems: String(result.successful),
            });

            return { success: true, reprocessed: result };
          }
        } catch (error) {
          const domeError = toDomeError(error, 'Error in reprocess operation', {
            service: 'ai-processor',
            operation: 'reprocess',
            id: data.id,
            requestId,
          });

          logError(domeError, 'Failed to reprocess content');

          aiProcessorMetrics.trackOperation('reprocess', false, {
            errorType: domeError.code,
            requestId,
          });

          throw domeError;
        }
      },
      { requestId, id: data.id },
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
  private async reprocessById(
    id: string,
    requestId: string,
  ): Promise<{ id: string; success: boolean }> {
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
            requestId,
          });

          // Add this check to satisfy TypeScript's null analysis after assertExists
          if (!metadata) {
            // This case should ideally not be reached if assertExists works as expected
            // and throws an error. Logging it as an unexpected situation.
            logError(
              new Error(`Metadata unexpectedly null after assertExists for ID: ${id}`),
              'Unexpected null metadata',
              {
                id,
                operation: 'reprocessById',
                requestId,
              },
            );
            return { id, success: false };
          }

          // Create a new content message and process it
          const message: NewContentMessage = {
            id: metadata.id,
            userId: metadata.userId,
            category: metadata.category,
            mimeType: metadata.mimeType,
          };

          await this.services.processor.processMessage(message, requestId);

          aiProcessorMetrics.trackOperation('reprocess_by_id', true, {
            id,
            requestId,
            contentType: metadata.category || metadata.mimeType || 'unknown',
          });

          return { id, success: true };
        } catch (error) {
          const domeError = toDomeError(error, `Error reprocessing content with ID ${id}`, {
            id,
            operation: 'reprocessById',
            requestId,
          });

          logError(domeError, `Failed to reprocess content ID: ${id}`);

          aiProcessorMetrics.trackOperation('reprocess_by_id', false, {
            id,
            requestId,
            errorType: domeError.code,
          });

          return { id, success: false };
        }
      },
      { id, requestId },
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
  private async reprocessFailedContent(
    requestId: string,
  ): Promise<{ total: number; successful: number }> {
    return trackOperation(
      'reprocess_failed_content',
      async () => {
        try {
          // Get all content with null or "Content processing failed" summary
          const failedContent = await this.services.silo.findContentWithFailedSummary();

          getLogger().info(
            {
              count: failedContent.length,
              requestId,
              operation: 'reprocessFailedContent',
            },
            'Found content with failed summaries',
          );

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

              await this.services.processor.processMessage(message, requestId);
              successful++;

              // Log progress periodically for long-running batch operations
              if (successful % 10 === 0) {
                getLogger().info(
                  {
                    requestId,
                    progress: `${successful}/${failedContent.length}`,
                    percentComplete: Math.round((successful / failedContent.length) * 100),
                    operation: 'reprocessFailedContent',
                  },
                  'Batch reprocessing progress',
                );
              }
            } catch (error) {
              errors++;
              const domeError = toDomeError(error, `Error reprocessing content ID: ${content.id}`, {
                id: content.id,
                requestId,
                operation: 'reprocessFailedContent',
              });

              logError(domeError, `Failed to reprocess content during batch operation`);
            }
          }

          aiProcessorMetrics.trackOperation('reprocess_batch', true, {
            totalItems: String(failedContent.length),
            successfulItems: String(successful),
            failedItems: String(errors),
            requestId,
          });

          getLogger().info(
            {
              total: failedContent.length,
              successful,
              errors,
              requestId,
              successRate:
                failedContent.length > 0
                  ? Math.round((successful / failedContent.length) * 100)
                  : 0,
              operation: 'reprocessFailedContent',
            },
            'Completed batch reprocessing of failed content',
          );

          return { total: failedContent.length, successful };
        } catch (error) {
          const domeError = toDomeError(error, 'Error reprocessing failed content batch', {
            requestId,
            operation: 'reprocessFailedContent',
          });

          logError(domeError, 'Failed to reprocess content batch');

          aiProcessorMetrics.trackOperation('reprocess_batch', false, {
            errorType: domeError.code,
            requestId,
          });

          return { total: 0, successful: 0 };
        }
      },
      { requestId },
    );
  }

  /**
   * Queue handler for processing regular content messages
   * @param batch Batch of messages from the queue
   */
  async queue(batch: MessageBatch<NewContentMessage>) {
    const batchId = crypto.randomUUID();

    await trackOperation(
      'process_message_batch',
      async () => {
        const startTime = Date.now();
        const queueName = batch.queue;

        let parsed: ParsedMessageBatch<NewContentMessage>;
        try {
          parsed = NewContentQueue.parseBatch(batch);
        } catch (err) {
          const domeError = toDomeError(err, 'Failed to parse message batch', {
            batchId,
            queueName,
          });
          logError(domeError, 'Invalid queue batch');
          aiProcessorMetrics.counter('batch.errors', 1, {
            queueName,
            errorType: domeError.code,
          });
          throw domeError;
        }

        getLogger().info(
          {
            queueName,
            batchId,
            messageCount: parsed.messages.length,
            firstMessageId: parsed.messages[0]?.id,
            operation: 'queue',
          },
          'Processing queue batch',
        );

        // Track batch metrics
        aiProcessorMetrics.counter('batch.received', 1, { queueName });
        aiProcessorMetrics.counter('messages.received', parsed.messages.length, { queueName });

        let successCount = 0;
        let errorCount = 0;

        // Process each message in the batch
        for (const message of parsed.messages) {
          const messageRequestId = `${batchId}-${message.id}`;
          try {
            await this.services.processor.processMessage(message.body, messageRequestId);
            successCount++;
          } catch (error) {
            errorCount++;
            const domeError = toDomeError(error, 'Failed to process queue message', {
              messageId: message.id,
              contentId: message.body?.id,
              batchId,
              requestId: messageRequestId,
            });

            logError(domeError, 'Failed to process message from queue');
            aiProcessorMetrics.counter('messages.errors', 1, {
              queueName,
              errorType: domeError.code,
            });
          }
        }

        // Log batch completion with detailed statistics
        const duration = Date.now() - startTime;
        getLogger().info(
          {
            queueName,
            batchId,
            messageCount: parsed.messages.length,
            successCount,
            errorCount,
            successRate: Math.round((successCount / parsed.messages.length) * 100),
            durationMs: duration,
            avgProcessingTimeMs: Math.round(duration / parsed.messages.length),
            operation: 'queue',
          },
          'Completed processing queue batch',
        );

        // Track detailed batch metrics
        aiProcessorMetrics.timing('batch.duration_ms', duration, { queueName });
        aiProcessorMetrics.counter('batch.completed', 1, { queueName });
        aiProcessorMetrics.counter('messages.processed', successCount, { queueName });
        aiProcessorMetrics.gauge('batch.success_rate', successCount / parsed.messages.length, {
          queueName,
        });
      },
      { batchId, queueName: batch.queue, messageCount: batch.messages.length },
    );
  }
}
