/**
 * Silo Service entrypoint
 *
 * This is the main entry point for the Silo service, implementing a WorkerEntrypoint
 * class that handles both RPC methods and queue processing.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { getLogger, logError, metrics } from '@dome/logging';
import { R2Event } from './types';
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
   * Queue consumer for processing R2 object-created events
   */
  async queue(batch: MessageBatch<R2Event | EnrichedContentMessage | SiloSimplePutInput>) {
    await wrap(
      { op: 'queue', queue: batch.queue, size: batch.messages.length, ...this.env },
      async () => {
        try {
          // Determine which queue we're processing
          if (batch.queue === 'content-events') {
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

                // Acknowledge the message to avoid retries for validation errors
                // For other errors, we might want to retry
                if (error instanceof z.ZodError) {
                  message.ack();
                } else {
                  throw error; // Allow retry for other errors
                }
              }
            });

            await Promise.all(promises);
          } else if (batch.queue === 'ingest-queue') {
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

                // Acknowledge the message to avoid retries for validation errors
                if (error instanceof z.ZodError) {
                  message.ack();
                } else {
                  throw error; // Allow retry for other errors
                }
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
      },
    );
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
}
