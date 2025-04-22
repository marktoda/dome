/**
 * Silo Service entrypoint
 *
 * This is the main entry point for the Silo service, implementing a WorkerEntrypoint
 * class that handles both RPC methods and queue processing.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { getLogger, logError, metrics } from '@dome/logging';
import { DLQMessage, R2Event, DLQFilterOptions, DLQStats } from './types';
import { wrap } from './utils/wrap';
import { createServices, Services } from './services';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { EnrichedContentMessage, EnrichedContentMessageSchema } from '@dome/common';
import {
  siloSimplePutSchema,
  siloBatchGetSchema,
  siloDeleteSchema,
  siloStatsSchema,
  SiloSimplePutInput,
  SiloBatchGetInput,
  SiloDeleteInput,
  SiloStatsInput,
  SiloSimplePutResponse,
  SiloBatchGetResponse,
  SiloDeleteResponse,
  SiloStatsResponse,
} from '@dome/common';

/**
 * Silo service main class
 */
export default class Silo extends WorkerEntrypoint<Env> {
  private services: Services;

  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, env);
    this.services = createServices(env);
  }

  /**
   * Send a message to the DLQ
   * This is a wrapper around the DLQService implementation for backward compatibility
   */
  private async sendToDLQ<T>(
    message: { body: T; id: string; retryCount?: number; attempts?: number; ack: () => void },
    error: Error,
    queueName: string,
    retryCount?: number,
  ): Promise<void> {
    try {
      // Use retryCount parameter if provided, otherwise use message.retryCount or message.attempts
      const actualRetryCount = retryCount ?? message.retryCount ?? message.attempts ?? 0;

      await this.services.dlq.sendToDLQ(message.body, error, {
        queueName,
        messageId: message.id,
        retryCount: actualRetryCount,
      });

      // Acknowledge the original message since it's now in the DLQ
      message.ack();

      getLogger().info(
        { messageId: message.id, error: error.message, queueName },
        'Message sent to DLQ',
      );
    } catch (dlqError) {
      // If we can't send to DLQ, log the error but still acknowledge the message
      // to prevent an infinite retry loop
      logError(
        getLogger(),
        dlqError,
        'Error sending message to DLQ, acknowledging original message anyway',
        { originalError: error.message, messageId: message.id },
      );
      message.ack();
    }
  }

  /**
   * Queue consumer for processing R2 object-created events
   */
  async queue(batch: MessageBatch<any>) {
    await wrap({ op: 'queue', queue: batch.queue, size: batch.messages.length }, async () => {
      try {
        // Determine which queue we're processing
        if (batch.queue === 'silo-content-uploaded') {
          // Process R2 events
          const promises = batch.messages.map(async message => {
            const event = message.body as R2Event;
            if (event.action === 'PutObject') {
              // Extract key from the event
              const { key } = event.object;

              // Get object metadata from R2
              const obj = await this.services.content.processR2Event(event);

              // Acknowledge the message
              message.ack();
            } else {
              getLogger().warn({ event }, 'Unsupported event action: ' + event.action);
              message.ack(); // Acknowledge anyway to avoid retries
            }
          });

          await Promise.all(promises);
        } else if (batch.queue === 'enriched-content') {
          // Process enriched content from AI processor
          const promises = batch.messages.map(async message => {
            try {
              // Validate the message
              const enrichedContent = EnrichedContentMessageSchema.parse(message.body);

              // Process the enriched content
              await this.services.content.processEnrichedContent(enrichedContent);

              // Acknowledge the message
              message.ack();
            } catch (error) {
              getLogger().error(
                { error, messageId: message.id },
                'Error processing enriched content message',
              );

              // For validation errors, send to DLQ immediately
              if (error instanceof z.ZodError) {
                await this.services.dlq.sendToDLQ(message.body, error, {
                  queueName: 'enriched-content',
                  messageId: message.id,
                  retryCount: message.attempts,
                });
                message.ack();
              } else if (message.attempts >= 3) {
                // attempts starts at 1, so 3 means 2 retries
                // If this is the final retry attempt, send to DLQ
                await this.services.dlq.sendToDLQ(message.body, error as Error, {
                  queueName: 'enriched-content',
                  messageId: message.id,
                  retryCount: message.attempts,
                });
                message.ack();
              } else {
                // Otherwise, allow retry
                throw error;
              }
            }
          });

          await Promise.all(promises);
        } else if (batch.queue === 'silo-ingest-queue') {
          // Process ingest queue messages
          const promises = batch.messages.map(async message => {
            try {
              // Validate the message
              const ingestMessage = siloSimplePutSchema.parse(message.body);

              // Process the ingest message
              await this.services.content.processIngestMessage(ingestMessage);

              // Acknowledge the message
              message.ack();
            } catch (error) {
              getLogger().error(
                { error, messageId: message.id },
                'Error processing ingest queue message',
              );

              // For validation errors, send to DLQ immediately
              if (error instanceof z.ZodError) {
                await this.services.dlq.sendToDLQ(message.body, error, {
                  queueName: 'silo-ingest-queue',
                  messageId: message.id,
                  retryCount: message.attempts,
                });
                message.ack();
              } else if (message.attempts >= 3) {
                // attempts starts at 1, so 3 means 2 retries
                // If this is the final retry attempt, send to DLQ
                await this.services.dlq.sendToDLQ(message.body, error as Error, {
                  queueName: 'silo-ingest-queue',
                  messageId: message.id,
                  retryCount: message.attempts,
                });
                message.ack();
              } else {
                // Otherwise, allow retry
                throw error;
              }
            }
          });

          await Promise.all(promises);
        } else if (batch.queue === 'ingest-dlq') {
          // Process DLQ messages
          const promises = batch.messages.map(async message => {
            try {
              // Log the DLQ message
              getLogger().info({ messageId: message.id }, 'Processing message from DLQ');

              // Just acknowledge the message for now
              // In a real implementation, we might have special handling for DLQ messages
              message.ack();
            } catch (error) {
              // Log the error but acknowledge the message to prevent infinite retries
              logError(getLogger(), error, 'Error processing DLQ message, acknowledging anyway', {
                messageId: message.id,
              });
              message.ack();
            }
          });

          await Promise.all(promises);
        } else {
          getLogger().warn({ queue: batch.queue }, 'Unknown queue');
        }
      } catch (error) {
        metrics.increment('silo.queue.errors', 1);
        logError(getLogger(), error, 'Queue processing error', { queue: batch.queue });
        throw error; // Allow retry
      }
    });
  }

  /**
   * Efficiently retrieve multiple content items
   */
  async batchGet(data: SiloBatchGetInput): Promise<SiloBatchGetResponse> {
    return wrap({ operation: 'batchGet' }, async () => {
      try {
        // Validate input
        const validatedData = siloBatchGetSchema.parse(data);
        return await this.services.content.batchGet(validatedData);
      } catch (error) {
        if (error instanceof z.ZodError) {
          getLogger().error({ error: error.errors }, 'Validation error in batchGet');
          metrics.increment('silo.validation.errors', 1, { method: 'batchGet' });
          throw new Error(
            `Validation error: ${error.errors
              .map(e => `${e.path.join('.')}: ${e.message}`)
              .join(', ')}`,
          );
        }
        logError(getLogger(), error, 'Error in batchGet');
        metrics.increment('silo.rpc.errors', 1, { method: 'batchGet' });
        throw error;
      }
    });
  }

  /**
   * Delete content items
   */
  async delete(data: SiloDeleteInput): Promise<SiloDeleteResponse> {
    return wrap({ operation: 'delete', id: data.id }, async () => {
      try {
        // Validate input
        const validatedData = siloDeleteSchema.parse(data);
        return await this.services.content.delete(validatedData);
      } catch (error) {
        if (error instanceof z.ZodError) {
          getLogger().error({ error: error.errors }, 'Validation error in delete');
          metrics.increment('silo.validation.errors', 1, { method: 'delete' });
          throw new Error(
            `Validation error: ${error.errors
              .map(e => `${e.path.join('.')}: ${e.message}`)
              .join(', ')}`,
          );
        }
        logError(getLogger(), error, 'Error in delete');
        metrics.increment('silo.rpc.errors', 1, { method: 'delete' });
        throw error;
      }
    });
  }

  /**
   * Get storage statistics
   */
  async stats(data: SiloStatsInput = {}): Promise<SiloStatsResponse> {
    return wrap({ operation: 'stats' }, async () => {
      try {
        // Validate input (empty object is fine for stats)
        siloStatsSchema.parse(data);
        return await this.services.stats.getStats();
      } catch (error) {
        if (error instanceof z.ZodError) {
          getLogger().error({ error: error.errors }, 'Validation error in stats');
          metrics.increment('silo.validation.errors', 1, { method: 'stats' });
          throw new Error(
            `Validation error: ${error.errors
              .map(e => `${e.path.join('.')}: ${e.message}`)
              .join(', ')}`,
          );
        }
        logError(getLogger(), error, 'Error in stats');
        metrics.increment('silo.rpc.errors', 1, { method: 'stats' });
        throw error;
      }
    });
  }

  /**
   * Get DLQ statistics
   */
  async dlqStats(): Promise<DLQStats> {
    return wrap({ operation: 'dlqStats' }, async () => {
      try {
        return await this.services.dlq.getStats();
      } catch (error) {
        logError(getLogger(), error, 'Error in dlqStats');
        metrics.increment('silo.rpc.errors', 1, { method: 'dlqStats' });
        throw error;
      }
    });
  }

  /**
   * Get DLQ messages
   */
  async dlqMessages(options: DLQFilterOptions = {}): Promise<DLQMessage<unknown>[]> {
    return wrap({ operation: 'dlqMessages' }, async () => {
      try {
        return await this.services.dlq.getMessages(options);
      } catch (error) {
        logError(getLogger(), error, 'Error in dlqMessages');
        metrics.increment('silo.rpc.errors', 1, { method: 'dlqMessages' });
        throw error;
      }
    });
  }

  /**
   * Reprocess DLQ message
   */
  async dlqReprocess(id: string): Promise<string> {
    return wrap({ operation: 'dlqReprocess', id }, async () => {
      try {
        return await this.services.dlq.reprocessMessage(id);
      } catch (error) {
        logError(getLogger(), error, 'Error in dlqReprocess');
        metrics.increment('silo.rpc.errors', 1, { method: 'dlqReprocess' });
        throw error;
      }
    });
  }

  /**
   * Purge DLQ messages
   */
  async dlqPurge(options: DLQFilterOptions = {}): Promise<number> {
    return wrap({ operation: 'dlqPurge' }, async () => {
      try {
        return await this.services.dlq.purgeMessages(options);
      } catch (error) {
        logError(getLogger(), error, 'Error in dlqPurge');
        metrics.increment('silo.rpc.errors', 1, { method: 'dlqPurge' });
        throw error;
      }
    });
  }
}
