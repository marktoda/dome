import { getLogger, logError, metrics } from '@dome/logging';
import { drizzle } from 'drizzle-orm/d1';
import { eq, and, sql, desc, count } from 'drizzle-orm';
import { dlqMetadata } from '../db/schema';
import { DLQFilterOptions, DLQMessage, DLQStats } from '../types';
import { siloSimplePutSchema } from '@dome/common';

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
    try {
      const id = crypto.randomUUID();
      const now = Date.now();

      await this.db
        .insert(dlqMetadata)
        .values({
          id,
          originalMessageId: message.processingMetadata.messageId,
          queueName: message.processingMetadata.queueName,
          errorMessage: message.error.message,
          errorName: message.error.name,
          failedAt: message.processingMetadata.failedAt,
          retryCount: message.processingMetadata.retryCount,
          reprocessed: Boolean(message.recovery.reprocessed),
          originalMessageType: typeof message.originalMessage,
          originalMessageJson: JSON.stringify(message.originalMessage),
        })
        .run();

      metrics.increment('silo.dlq.metadata_stored', 1);
      return id;
    } catch (error) {
      metrics.increment('silo.dlq.metadata_errors', 1);
      logError(error, 'Error storing DLQ message metadata');
      throw error;
    }
  }

  async getDLQMessages(options: DLQFilterOptions = {}): Promise<DLQMessage<unknown>[]> {
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

      // Map DB results to DLQMessage objects
      return results.map((row: any) => {
        const originalMessage = JSON.parse(row.originalMessageJson);
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
      logError(error, 'Error retrieving DLQ messages');
      throw error;
    }
  }

  async getDLQStats(): Promise<DLQStats> {
    try {
      // Get total count
      const totalResult = await this.db.select({ count: count() }).from(dlqMetadata).get();

      const total = Number(totalResult?.count || 0);

      // Get reprocessed count
      const reprocessedResult = await this.db
        .select({ count: count() })
        .from(dlqMetadata)
        .where(sql`${dlqMetadata.reprocessed} = 1`)
        .get();

      const reprocessed = Number(reprocessedResult?.count || 0);

      // Get counts by queue name
      const queueCounts = await this.db
        .select({
          queueName: dlqMetadata.queueName,
          count: count(),
        })
        .from(dlqMetadata)
        .groupBy(dlqMetadata.queueName)
        .all();

      // Get counts by error type
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

      return {
        totalMessages: total,
        reprocessedMessages: reprocessed,
        pendingMessages: total - reprocessed,
        byQueueName,
        byErrorType,
      };
    } catch (error) {
      logError(error, 'Error retrieving DLQ stats');
      throw error;
    }
  }

  async markAsReprocessed(id: string, result: string): Promise<void> {
    try {
      const now = Date.now();

      await this.db
        .update(dlqMetadata)
        .set({
          reprocessed: true,
          reprocessedAt: now,
          recoveryResult: result,
        })
        .where(eq(dlqMetadata.id, id))
        .run();
    } catch (error) {
      logError(error, 'Error marking DLQ message as reprocessed');
      throw error;
    }
  }

  async reprocessMessage(id: string): Promise<string> {
    try {
      // Get the message from the database
      const message = await this.db.select().from(dlqMetadata).where(eq(dlqMetadata.id, id)).get();

      if (!message) {
        throw new Error(`DLQ message with ID ${id} not found`);
      }

      if (message.reprocessed) {
        return `Message ${id} was already reprocessed at ${new Date(
          message.reprocessedAt || 0,
        ).toISOString()}`;
      }

      // Parse the original message
      const originalMessage = JSON.parse(message.originalMessageJson);

      // Determine the queue to send to based on the original queue
      let result = '';

      if (message.queueName === 'silo-ingest-queue') {
        // Validate the message
        const validatedMessage = siloSimplePutSchema.parse(originalMessage);

        // Send to the original queue
        if (this.env.SILO_INGEST_QUEUE) {
          await this.env.SILO_INGEST_QUEUE.send(validatedMessage);
          result = 'Successfully requeued to silo-ingest-queue';
        } else {
          result = 'SILO_INGEST_QUEUE binding not available';
        }
      } else {
        result = `Unsupported queue: ${message.queueName}`;
      }

      // Mark as reprocessed
      await this.markAsReprocessed(id, result);

      metrics.increment('silo.dlq.reprocessed', 1);
      metrics.increment('silo.dlq.reprocessing_success', 1);

      return result;
    } catch (error) {
      metrics.increment('silo.dlq.reprocessing_errors', 1);
      logError(error, 'Error reprocessing DLQ message');
      throw error;
    }
  }

  async reprocessMessages(ids: string[]): Promise<Record<string, string>> {
    const results: Record<string, string> = {};

    for (const id of ids) {
      try {
        results[id] = await this.reprocessMessage(id);
      } catch (error) {
        if (error instanceof Error) {
          results[id] = `Error: ${error.message}`;
        } else {
          results[id] = `Unknown error occurred`;
        }
      }
    }

    return results;
  }

  async purgeMessages(options: DLQFilterOptions = {}): Promise<number> {
    try {
      const { queueName, errorType, reprocessed, startDate, endDate } = options;

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

      // Execute delete query
      const result = await this.db
        .delete(dlqMetadata)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .run();

      // D1 result might have changes property
      const changes = (result as any).changes || 0;
      return changes;
    } catch (error) {
      logError(error, 'Error purging DLQ messages');
      throw error;
    }
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
    try {
      const now = Date.now();

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
      if (this.env.INGEST_DLQ) {
        await this.env.INGEST_DLQ.send(dlqMessage);
      } else {
        getLogger().warn('INGEST_DLQ binding not available, message not sent to queue');
      }

      // Store metadata in database
      const id = await this.storeDLQMessage(dlqMessage);

      metrics.increment('silo.dlq.messages', 1, {
        queue: metadata.queueName,
        error_type: error.name,
      });

      return id;
    } catch (error) {
      metrics.increment('silo.dlq.errors', 1);
      logError(error, 'Error sending message to DLQ');
      throw error;
    }
  }
}

/**
 * Create a new DLQ service
 */
export function createDLQService(env: Env): DLQService {
  return new DLQServiceImpl(env);
}
