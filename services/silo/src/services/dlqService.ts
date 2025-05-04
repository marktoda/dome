import {
  getLogger,
  logError,
  metrics,
  trackOperation,
  logOperationStart,
  logOperationSuccess,
} from '@dome/common';
import {
  DomeError,
  NotFoundError,
  ValidationError,
  toDomeError,
  assertValid,
  assertExists,
} from '@dome/errors';
import { drizzle } from 'drizzle-orm/d1';
import { eq, and, sql, desc, count } from 'drizzle-orm';
import { dlqMetadata } from '../db/schema';
import { DLQFilterOptions, DLQMessage, DLQStats } from '../types';
import { siloSimplePutSchema } from '@dome/common';
import { z } from 'zod';

/**
 * DLQ Service interface
 */
export interface DLQService {
  /**
   * Store a message in the DLQ
   */
  storeDLQMessage<T>(message: DLQMessage<T>): Promise<string>;

  /**
   * Get DLQ messages with filtering options
   */
  getDLQMessages(options?: DLQFilterOptions): Promise<DLQMessage<unknown>[]>;

  /**
   * Get DLQ statistics
   */
  getDLQStats(): Promise<DLQStats>;

  /**
   * Mark a DLQ message as reprocessed
   */
  markAsReprocessed(id: string, result: string): Promise<void>;

  /**
   * Reprocess a DLQ message
   */
  reprocessMessage(id: string): Promise<string>;

  /**
   * Reprocess multiple DLQ messages
   */
  reprocessMessages(ids: string[]): Promise<Record<string, string>>;

  /**
   * Purge DLQ messages
   */
  purgeMessages(options?: DLQFilterOptions): Promise<number>;

  /**
   * Send a message to the DLQ
   */
  sendToDLQ<T>(
    originalMessage: T,
    error: Error,
    metadata: {
      queueName: string;
      messageId: string;
      retryCount: number;
      producerService?: string;
    },
  ): Promise<string>;
}

/**
 * DLQ Service implementation
 */
export class DLQServiceImpl implements DLQService {
  private db: ReturnType<typeof drizzle>;

  constructor(private env: Env) {
    this.db = drizzle(env.DB);
  }

  async storeDLQMessage<T>(message: DLQMessage<T>): Promise<string> {
    return trackOperation('silo.dlq.storeDLQMessage', async () => {
      try {
        // Validate message has required fields
        assertValid(!!message, 'DLQ message is required', { operation: 'storeDLQMessage' });
        assertValid(!!message.processingMetadata, 'DLQ message must include processing metadata', {
          operation: 'storeDLQMessage',
        });
        assertValid(!!message.error, 'DLQ message must include error information', {
          operation: 'storeDLQMessage',
        });

        // Generate message ID and track metrics
        const id = crypto.randomUUID();
        const now = Date.now();

        const logContext = {
          messageId: id,
          originalMessageId: message.processingMetadata.messageId,
          queueName: message.processingMetadata.queueName,
          errorName: message.error.name,
          retryCount: message.processingMetadata.retryCount,
        };

        // Log message details
        getLogger().info(
          logContext,
          `Storing DLQ message with original ID ${message.processingMetadata.messageId} from queue ${message.processingMetadata.queueName}`,
        );

        await this.db
          .insert(dlqMetadata)
          .values({
            id,
            originalMessageId: message.processingMetadata.messageId,
            queueName: message.processingMetadata.queueName,
            errorMessage: message.error.message,
            errorName: message.error.name,
            failedAt: message.processingMetadata.failedAt || now,
            retryCount: message.processingMetadata.retryCount,
            reprocessed: Boolean(message.recovery.reprocessed),
            originalMessageType: typeof message.originalMessage,
            originalMessageJson: JSON.stringify(message.originalMessage),
          })
          .run();

        // Track success metrics with context
        metrics.increment('silo.dlq.metadata_stored', 1, {
          queue: message.processingMetadata.queueName,
          error_type: message.error.name,
        });

        getLogger().info(logContext, `Successfully stored DLQ message with ID ${id}`);

        return id;
      } catch (error) {
        // Handle different error types
        if (error instanceof DomeError) {
          // Add relevant context to the error
          error.withContext({
            operation: 'storeDLQMessage',
            originalMessageId: message?.processingMetadata?.messageId,
            queueName: message?.processingMetadata?.queueName,
          });

          metrics.increment('silo.dlq.metadata_errors', 1, {
            error_type: error.code,
            validation_error: error instanceof ValidationError ? 'true' : 'false',
          });

          logError(error, 'Failed to store DLQ message due to validation error');
          throw error;
        }

        // Handle database-specific errors
        const domeError = toDomeError(error, 'Failed to store DLQ message metadata', {
          operation: 'storeDLQMessage',
          originalMessageId: message?.processingMetadata?.messageId,
          queueName: message?.processingMetadata?.queueName,
        });

        metrics.increment('silo.dlq.metadata_errors', 1, {
          error_type: domeError.code,
        });

        logError(domeError, 'Error storing DLQ message metadata', {
          originalMessageId: message?.processingMetadata?.messageId,
          queueName: message?.processingMetadata?.queueName,
        });

        throw domeError;
      }
    });
  }

  async getDLQMessages(options: DLQFilterOptions = {}): Promise<DLQMessage<unknown>[]> {
    return trackOperation('silo.dlq.getDLQMessages', async () => {
      try {
        const {
          queueName,
          errorType,
          reprocessed,
          startDate,
          endDate,
          limit = 100,
          offset = 0,
        } = options;

        // Create filter context for logging
        const filterContext = {
          queueName: queueName || 'all',
          errorType: errorType || 'all',
          reprocessed: reprocessed !== undefined ? String(reprocessed) : 'all',
          startDate: startDate ? new Date(startDate).toISOString() : undefined,
          endDate: endDate ? new Date(endDate).toISOString() : undefined,
          limit,
          offset,
        };

        getLogger().info(
          {
            operation: 'getDLQMessages',
            filters: filterContext,
          },
          `Retrieving DLQ messages with filters: ${JSON.stringify(filterContext)}`,
        );

        // Build query conditions
        const conditions = [];
        if (queueName) {
          conditions.push(eq(dlqMetadata.queueName, queueName));
        }
        if (errorType) {
          conditions.push(eq(dlqMetadata.errorName, errorType));
        }
        if (reprocessed !== undefined) {
          conditions.push(sql`${dlqMetadata.reprocessed} = ${reprocessed ? 1 : 0}`);
        }
        if (startDate) {
          conditions.push(sql`${dlqMetadata.failedAt} >= ${startDate}`);
        }
        if (endDate) {
          conditions.push(sql`${dlqMetadata.failedAt} <= ${endDate}`);
        }

        // Execute query
        const results = await this.db
          .select()
          .from(dlqMetadata)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(dlqMetadata.failedAt))
          .limit(limit)
          .offset(offset)
          .all();

        // Log success with result count
        getLogger().info(
          {
            operation: 'getDLQMessages',
            messageCount: results.length,
            filters: filterContext,
          },
          `Retrieved ${results.length} DLQ messages`,
        );

        // Track metrics
        metrics.gauge('silo.dlq.retrieved_messages', results.length, {
          queue: queueName || 'all',
          reprocessed: reprocessed !== undefined ? String(reprocessed) : 'all',
        });

        // Map DB results to DLQMessage objects with safer parsing
        return results.map((row: any) => {
          let originalMessage;
          try {
            originalMessage = JSON.parse(row.originalMessageJson);
          } catch (parseError) {
            getLogger().warn(
              {
                messageId: row.id,
                parseError: parseError instanceof Error ? parseError.message : String(parseError),
              },
              `Failed to parse original message JSON for DLQ message ${row.id}`,
            );
            originalMessage = { __parsing_failed: true, raw: row.originalMessageJson };
          }

          return {
            originalMessage,
            error: {
              message: row.errorMessage,
              name: row.errorName,
            },
            processingMetadata: {
              failedAt: row.failedAt,
              retryCount: row.retryCount,
              queueName: row.queueName,
              messageId: row.originalMessageId,
            },
            recovery: {
              reprocessed: Boolean(row.reprocessed),
              reprocessedAt: row.reprocessedAt || undefined,
              recoveryResult: row.recoveryResult || undefined,
            },
          };
        });
      } catch (error) {
        // Convert to DomeError with context
        const domeError = toDomeError(error, 'Failed to retrieve DLQ messages', {
          operation: 'getDLQMessages',
          filters: JSON.stringify(options),
        });

        // Log structured error
        logError(domeError, 'Error retrieving DLQ messages', {
          filters: JSON.stringify(options),
        });

        // Track error metrics
        metrics.increment('silo.dlq.query_errors', 1, {
          error_type: domeError.code,
        });

        throw domeError;
      }
    });
  }

  async getDLQStats(): Promise<DLQStats> {
    return trackOperation('silo.dlq.getStats', async () => {
      try {
        logOperationStart('silo.dlq.getStats', { component: 'DLQService' });
        const startTime = performance.now();

        // Get total count
        getLogger().debug(
          { operation: 'getDLQStats', step: 'getTotalCount' },
          'Getting total message count',
        );
        const totalResult = await this.db.select({ count: count() }).from(dlqMetadata).get();
        const total = Number(totalResult?.count || 0);

        // Get reprocessed count
        getLogger().debug(
          { operation: 'getDLQStats', step: 'getReprocessedCount' },
          'Getting reprocessed message count',
        );
        const reprocessedResult = await this.db
          .select({ count: count() })
          .from(dlqMetadata)
          .where(sql`${dlqMetadata.reprocessed} = 1`)
          .get();
        const reprocessed = Number(reprocessedResult?.count || 0);

        // Get counts by queue name
        getLogger().debug(
          { operation: 'getDLQStats', step: 'getQueueCounts' },
          'Getting counts by queue name',
        );
        const queueCounts = await this.db
          .select({
            queueName: dlqMetadata.queueName,
            count: count(),
          })
          .from(dlqMetadata)
          .groupBy(dlqMetadata.queueName)
          .all();

        // Get counts by error type
        getLogger().debug(
          { operation: 'getDLQStats', step: 'getErrorCounts' },
          'Getting counts by error type',
        );
        const errorCounts = await this.db
          .select({
            errorName: dlqMetadata.errorName,
            count: count(),
          })
          .from(dlqMetadata)
          .groupBy(dlqMetadata.errorName)
          .all();

        // Build stats object
        const byQueueName: Record<string, number> = {};
        queueCounts.forEach((row: any) => {
          byQueueName[row.queueName] = Number(row.count);
        });

        const byErrorType: Record<string, number> = {};
        errorCounts.forEach((row: any) => {
          byErrorType[row.errorName] = Number(row.count);
        });

        const result = {
          totalMessages: total,
          reprocessedMessages: reprocessed,
          pendingMessages: total - reprocessed,
          byQueueName,
          byErrorType,
        };

        // Track metrics for monitoring
        Object.entries(byQueueName).forEach(([queue, count]) => {
          metrics.gauge('silo.dlq.queue_messages', count, { queue });
        });

        Object.entries(byErrorType).forEach(([errorType, count]) => {
          metrics.gauge('silo.dlq.error_type_count', count, { error_type: errorType });
        });

        metrics.gauge('silo.dlq.total_messages', total);
        metrics.gauge('silo.dlq.pending_messages', total - reprocessed);
        metrics.gauge('silo.dlq.reprocessed_messages', reprocessed);

        const duration = performance.now() - startTime;
        getLogger().info(
          {
            operation: 'getDLQStats',
            duration,
            totalMessages: total,
            pendingMessages: total - reprocessed,
            reprocessedMessages: reprocessed,
            queueCount: Object.keys(byQueueName).length,
            errorTypeCount: Object.keys(byErrorType).length,
          },
          `Retrieved DLQ statistics in ${duration.toFixed(2)}ms: ${total} total, ${
            total - reprocessed
          } pending, ${reprocessed} reprocessed`,
        );

        return result;
      } catch (error) {
        // Convert to DomeError with detailed context
        const domeError = toDomeError(error, 'Failed to retrieve DLQ statistics', {
          operation: 'getDLQStats',
        });

        logError(domeError, 'Error retrieving DLQ statistics');

        // Track error metrics
        metrics.increment('silo.dlq.stats_errors', 1, {
          error_type: domeError.code,
        });

        throw domeError;
      }
    });
  }

  async markAsReprocessed(id: string, result: string): Promise<void> {
    return trackOperation(
      'silo.dlq.markAsReprocessed',
      async () => {
        try {
          // Validate inputs
          assertValid(!!id, 'Message ID is required for marking as reprocessed', {
            operation: 'markAsReprocessed',
          });

          // Check if message exists first
          const existingMessage = await this.db
            .select({ id: dlqMetadata.id })
            .from(dlqMetadata)
            .where(eq(dlqMetadata.id, id))
            .get();

          // Throw appropriate error if message doesn't exist
          assertExists(existingMessage, `DLQ message with ID ${id} not found`, {
            messageId: id,
            operation: 'markAsReprocessed',
          });

          const now = Date.now();
          const logContext = { messageId: id, timestamp: now };

          getLogger().info(
            logContext,
            `Marking DLQ message ${id} as reprocessed with result: ${result}`,
          );

          await this.db
            .update(dlqMetadata)
            .set({
              reprocessed: true,
              reprocessedAt: now,
              recoveryResult: result,
            })
            .where(eq(dlqMetadata.id, id))
            .run();

          // Log success and track metrics
          getLogger().info(logContext, `Successfully marked DLQ message ${id} as reprocessed`);

          metrics.increment('silo.dlq.marked_reprocessed', 1);
        } catch (error) {
          if (error instanceof DomeError) {
            // Already a DomeError, just add any additional context
            error.withContext({ messageId: id });

            logError(error, `Error marking DLQ message ${id} as reprocessed`);
            throw error;
          }

          // Convert to appropriate DomeError based on error type
          const domeError = toDomeError(error, `Failed to mark DLQ message ${id} as reprocessed`, {
            messageId: id,
            operation: 'markAsReprocessed',
          });

          logError(domeError, `Error marking DLQ message ${id} as reprocessed`);

          metrics.increment('silo.dlq.mark_errors', 1, {
            error_type: domeError.code,
          });

          throw domeError;
        }
      },
      { messageId: id },
    );
  }

  async reprocessMessage(id: string): Promise<string> {
    return trackOperation(
      'silo.dlq.reprocessMessage',
      async () => {
        try {
          // Validate inputs
          assertValid(!!id, 'Message ID is required for reprocessing', {
            operation: 'reprocessMessage',
          });

          const logContext = { messageId: id, operation: 'reprocessMessage' };

          getLogger().info(logContext, `Starting reprocessing of DLQ message ${id}`);

          // Get the message from the database
          const message = await this.db
            .select()
            .from(dlqMetadata)
            .where(eq(dlqMetadata.id, id))
            .get();

          // Use assertExists to throw a NotFoundError if message doesn't exist
          assertExists(message, `DLQ message with ID ${id} not found`, {
            messageId: id,
            operation: 'reprocessMessage',
          });

          // If already reprocessed, return early with info
          if (message?.reprocessed) {
            const reprocessedAt = new Date(message?.reprocessedAt ?? 0).toISOString();

            getLogger().info(
              {
                ...logContext,
                alreadyReprocessed: true,
                reprocessedAt,
              },
              `Message ${id} was already reprocessed at ${reprocessedAt}`,
            );

            return `Message ${id} was already reprocessed at ${reprocessedAt}`;
          }

          // Parse the original message with error handling
          let originalMessage;
          try {
            originalMessage = JSON.parse(message?.originalMessageJson ?? '{}');
          } catch (parseError) {
            const parseErrorMessage =
              parseError instanceof Error ? parseError.message : 'Unknown parsing error';

            const validationError = new ValidationError(
              `Failed to parse original message JSON for DLQ message ${id}`,
              {
                messageId: id,
                queueName: message?.queueName ?? 'unknown',
                parseError: parseErrorMessage,
              },
              parseError instanceof Error ? parseError : undefined,
            );

            logError(
              validationError,
              `Failed to parse original message JSON for DLQ message ${id}`,
            );

            metrics.increment('silo.dlq.reprocessing_errors', 1, { error_type: 'parse_error' });
            throw validationError;
          }

          // Determine the queue to send to based on the original queue
          let result = '';
          const queueName = message?.queueName ?? 'unknown';

          getLogger().info(
            { ...logContext, queueName },
            `Preparing to reprocess message from queue: ${queueName}`,
          );

          if (queueName === 'silo-ingest-queue') {
            try {
              // Validate the message against schema
              const validatedMessage = siloSimplePutSchema.parse(originalMessage);

              // Check if queue binding exists
              if (this.env.SILO_INGEST_QUEUE) {
                await this.env.SILO_INGEST_QUEUE.send(validatedMessage);
                result = 'Successfully requeued to silo-ingest-queue';

                getLogger().info(
                  { ...logContext, queueName },
                  `Successfully sent message to silo-ingest-queue`,
                );
              } else {
                result = 'SILO_INGEST_QUEUE binding not available';

                getLogger().warn(
                  { ...logContext, queueName },
                  `SILO_INGEST_QUEUE binding not available, couldn't requeue message`,
                );
              }
            } catch (validationError) {
              if (validationError instanceof z.ZodError) {
                // Create a structured ValidationError for schema validation failures
                const zodError = validationError as z.ZodError;
                const errorDetails = zodError.errors.map(e => ({
                  path: e.path.join('.'),
                  message: e.message,
                  code: e.code,
                }));

                const domeValidationError = new ValidationError(
                  `Invalid message format for reprocessing to ${queueName}`,
                  {
                    messageId: id,
                    queueName,
                    validationErrors: errorDetails,
                  },
                  validationError instanceof Error ? validationError : undefined,
                );

                logError(domeValidationError, `Message validation failed during reprocessing`);
                metrics.increment('silo.dlq.reprocessing_errors', 1, {
                  error_type: 'validation_error',
                });
                throw domeValidationError;
              } else {
                // Re-throw other errors
                throw validationError;
              }
            }
          } else {
            // Handle unsupported queue
            result = `Unsupported queue: ${queueName}`;
            getLogger().warn(
              { ...logContext, queueName },
              `Attempted to reprocess message from unsupported queue: ${queueName}`,
            );
          }

          // Mark as reprocessed with the result
          await this.markAsReprocessed(id, result);

          // Track metrics for successful reprocessing
          metrics.increment('silo.dlq.reprocessed', 1, { queue: queueName });
          metrics.increment('silo.dlq.reprocessing_success', 1, { queue: queueName });

          getLogger().info(
            { ...logContext, result, queueName },
            `Successfully completed reprocessing of DLQ message ${id}: ${result}`,
          );

          return result;
        } catch (error) {
          // For already handled DomeErrors, just add more context
          if (error instanceof DomeError) {
            error.withContext({ operation: 'reprocessMessage', messageId: id });

            metrics.increment('silo.dlq.reprocessing_errors', 1, {
              error_type: error.code,
            });

            logError(error, `Error reprocessing DLQ message ${id}`);
            throw error;
          }

          // Convert other errors to DomeError
          const domeError = toDomeError(error, `Failed to reprocess DLQ message ${id}`, {
            messageId: id,
            operation: 'reprocessMessage',
          });

          metrics.increment('silo.dlq.reprocessing_errors', 1, {
            error_type: domeError.code,
          });

          logError(domeError, `Error reprocessing DLQ message ${id}`);
          throw domeError;
        }
      },
      { messageId: id },
    );
  }

  async reprocessMessages(ids: string[]): Promise<Record<string, string>> {
    return trackOperation(
      'silo.dlq.reprocessMessages',
      async () => {
        // Validate input
        assertValid(Array.isArray(ids), 'Message IDs must be an array', {
          operation: 'reprocessMessages',
        });

        const logContext = {
          operation: 'reprocessMessages',
          messageCount: ids.length,
          messageIds: ids.join(','),
        };

        getLogger().info(logContext, `Starting batch reprocessing of ${ids.length} DLQ messages`);

        const results: Record<string, string> = {};
        const successIds: string[] = [];
        const failedIds: string[] = [];

        // Process each message and keep track of successes/failures
        for (const id of ids) {
          try {
            results[id] = await this.reprocessMessage(id);
            successIds.push(id);
          } catch (error) {
            failedIds.push(id);

            if (error instanceof DomeError) {
              results[id] = `Error (${error.code}): ${error.message}`;
            } else if (error instanceof Error) {
              results[id] = `Error: ${error.message}`;
            } else {
              results[id] = `Unknown error occurred`;
            }

            // We don't want to throw here, just collect errors
            getLogger().warn(
              {
                messageId: id,
                error: error instanceof Error ? error.message : String(error),
                errorType: error instanceof Error ? error.name : typeof error,
              },
              `Failed to reprocess message ${id}`,
            );
          }
        }

        // Log summary of batch processing
        getLogger().info(
          {
            operation: 'reprocessMessages',
            totalMessages: ids.length,
            successCount: successIds.length,
            failureCount: failedIds.length,
            failedIds: failedIds.join(','),
          },
          `Completed batch reprocessing: ${successIds.length} succeeded, ${failedIds.length} failed`,
        );

        // Track metrics for batch operations
        metrics.increment('silo.dlq.batch_reprocessed', successIds.length);
        if (failedIds.length > 0) {
          metrics.increment('silo.dlq.batch_failed', failedIds.length);
        }

        return results;
      },
      { messageCount: ids.length },
    );
  }

  async purgeMessages(options: DLQFilterOptions = {}): Promise<number> {
    return trackOperation(
      'silo.dlq.purgeMessages',
      async () => {
        try {
          const { queueName, errorType, reprocessed, startDate, endDate } = options;

          // Create filter context for logging
          const filterContext = {
            queueName: queueName || 'all',
            errorType: errorType || 'all',
            reprocessed: reprocessed !== undefined ? String(reprocessed) : 'all',
            startDate: startDate ? new Date(startDate).toISOString() : undefined,
            endDate: endDate ? new Date(endDate).toISOString() : undefined,
          };

          getLogger().info(
            {
              operation: 'purgeMessages',
              filters: filterContext,
            },
            `Purging DLQ messages with filters: ${JSON.stringify(filterContext)}`,
          );

          // Build query conditions
          const conditions = [];
          if (queueName) {
            conditions.push(eq(dlqMetadata.queueName, queueName));
          }
          if (errorType) {
            conditions.push(eq(dlqMetadata.errorName, errorType));
          }
          if (reprocessed !== undefined) {
            conditions.push(sql`${dlqMetadata.reprocessed} = ${reprocessed ? 1 : 0}`);
          }
          if (startDate) {
            conditions.push(sql`${dlqMetadata.failedAt} >= ${startDate}`);
          }
          if (endDate) {
            conditions.push(sql`${dlqMetadata.failedAt} <= ${endDate}`);
          }

          // Get count before deletion for better logging
          const countResult = await this.db
            .select({ count: count() })
            .from(dlqMetadata)
            .where(conditions.length > 0 ? and(...conditions) : undefined)
            .get();

          const potentialChanges = Number(countResult?.count || 0);

          if (potentialChanges > 100) {
            getLogger().warn(
              { operation: 'purgeMessages', potentialChanges, filters: filterContext },
              `Purging a large number of DLQ messages (${potentialChanges})`,
            );
          }

          // Execute delete query
          const result = await this.db
            .delete(dlqMetadata)
            .where(conditions.length > 0 ? and(...conditions) : undefined)
            .run();

          // D1 result might have changes property
          const changes = (result as any).changes || 0;

          // Log success with count
          getLogger().info(
            {
              operation: 'purgeMessages',
              changesCount: changes,
              filters: filterContext,
            },
            `Successfully purged ${changes} DLQ messages`,
          );

          // Track metrics for monitoring
          metrics.increment('silo.dlq.purged', changes, {
            queue: queueName || 'all',
            reprocessed: reprocessed !== undefined ? String(reprocessed) : 'all',
          });

          return changes;
        } catch (error) {
          // Convert to DomeError with context
          const domeError = toDomeError(error, 'Failed to purge DLQ messages', {
            operation: 'purgeMessages',
            filters: JSON.stringify(options),
          });

          logError(domeError, 'Error purging DLQ messages', {
            filters: JSON.stringify(options),
          });

          metrics.increment('silo.dlq.purge_errors', 1, {
            error_type: domeError.code,
          });

          throw domeError;
        }
      },
      { filters: JSON.stringify(options) },
    );
  }

  async sendToDLQ<T>(
    originalMessage: T,
    error: Error,
    metadata: {
      queueName: string;
      messageId: string;
      retryCount: number;
      producerService?: string;
    },
  ): Promise<string> {
    return trackOperation(
      'silo.dlq.sendToDLQ',
      async () => {
        try {
          // Validate parameters
          assertValid(!!originalMessage, 'Original message is required for DLQ', {
            operation: 'sendToDLQ',
          });

          assertValid(!!error, 'Error object is required for DLQ', {
            operation: 'sendToDLQ',
          });

          assertValid(!!metadata, 'Metadata is required for DLQ', {
            operation: 'sendToDLQ',
          });

          assertValid(!!metadata.queueName, 'Queue name is required in metadata', {
            operation: 'sendToDLQ',
          });

          assertValid(!!metadata.messageId, 'Message ID is required in metadata', {
            operation: 'sendToDLQ',
          });

          const now = Date.now();
          const logContext = {
            operation: 'sendToDLQ',
            queueName: metadata.queueName,
            messageId: metadata.messageId,
            retryCount: metadata.retryCount,
            errorType: error.name,
            producerService: metadata.producerService,
          };

          getLogger().info(
            logContext,
            `Sending message ${metadata.messageId} to DLQ from queue ${metadata.queueName} (retry count: ${metadata.retryCount})`,
          );

          // Create DLQ message
          const dlqMessage: DLQMessage<T> = {
            originalMessage,
            error: {
              message: error.message,
              name: error.name,
              stack: error.stack,
            },
            processingMetadata: {
              failedAt: now,
              retryCount: metadata.retryCount,
              queueName: metadata.queueName,
              messageId: metadata.messageId,
              producerService: metadata.producerService,
            },
            recovery: {
              reprocessed: false,
            },
          };

          // Send to DLQ queue if binding exists
          let queueSendResult = false;
          if (this.env.INGEST_DLQ) {
            try {
              await this.env.INGEST_DLQ.send(dlqMessage);
              queueSendResult = true;
              getLogger().debug(logContext, `Successfully sent message to INGEST_DLQ queue`);
            } catch (queueError) {
              // Log queue error but continue to store in database
              getLogger().warn(
                {
                  ...logContext,
                  queueError: queueError instanceof Error ? queueError.message : String(queueError),
                },
                `Failed to send message to INGEST_DLQ queue, continuing with database storage`,
              );
            }
          } else {
            getLogger().warn(
              logContext,
              'INGEST_DLQ binding not available, message not sent to queue',
            );
          }

          // Store metadata in database
          const id = await this.storeDLQMessage(dlqMessage);

          metrics.increment('silo.dlq.messages', 1, {
            queue: metadata.queueName,
            error_type: error.name,
            queue_sent: queueSendResult ? 'true' : 'false',
          });

          getLogger().info(
            { ...logContext, id, queueSendResult },
            `Successfully processed DLQ message - DB ID: ${id}, queue send: ${
              queueSendResult ? 'success' : 'skipped'
            }`,
          );

          return id;
        } catch (error) {
          // Already a DomeError
          if (error instanceof DomeError) {
            error.withContext({
              operation: 'sendToDLQ',
              queueName: metadata?.queueName,
              messageId: metadata?.messageId,
            });

            metrics.increment('silo.dlq.errors', 1, {
              error_type: error.code,
              queue: metadata?.queueName || 'unknown',
            });

            logError(error, `Error sending message to DLQ for queue ${metadata?.queueName}`);
            throw error;
          }

          // Convert to DomeError
          const domeError = toDomeError(error, 'Failed to send message to DLQ', {
            operation: 'sendToDLQ',
            queueName: metadata?.queueName,
            messageId: metadata?.messageId,
            errorType: error instanceof Error ? error.name : typeof error,
          });

          metrics.increment('silo.dlq.errors', 1, {
            error_type: domeError.code,
            queue: metadata?.queueName || 'unknown',
          });

          logError(domeError, `Error sending message to DLQ for queue ${metadata?.queueName}`);
          throw domeError;
        }
      },
      {
        queueName: metadata.queueName,
        messageId: metadata.messageId,
        errorType: error.name,
      },
    );
  }
}

/**
 * Create a new DLQ service
 */
export function createDLQService(env: Env): DLQService {
  return new DLQServiceImpl(env);
}
