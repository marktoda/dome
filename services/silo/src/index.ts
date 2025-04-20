/**
 * Silo Service entrypoint
 *
 * This is the main entry point for the Silo service, implementing a WorkerEntrypoint
 * class that handles both RPC methods and queue processing.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { getLogger, metrics } from '@dome/logging';
import { R2Event } from './types';
import { wrap } from './utils/wrap';
import { createServices, Services } from './services';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import {
  siloSimplePutSchema,
  siloCreateUploadSchema,
  siloBatchGetSchema,
  siloDeleteSchema,
  siloStatsSchema,
  SiloSimplePutInput,
  SiloCreateUploadInput,
  SiloBatchGetInput,
  SiloDeleteInput,
  SiloStatsInput,
  SiloSimplePutResponse,
  SiloCreateUploadResponse,
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
  async queue(batch: MessageBatch<R2Event>) {
    await wrap({ op: 'queue', size: batch.messages.length, ...this.env }, async () => {
      try {
        // Process each message in the batch
        const promises = batch.messages.map(async message => {
          const event = message.body;
          if (event.type === 'object.created') {
            // Extract key from the event
            const { key } = event.object;

            // Get object metadata from R2
            const obj = await this.services.content.processR2Event(event);

            // Acknowledge the message
            message.ack();
          } else {
            getLogger().warn({ event }, 'Unsupported event type');
            message.ack(); // Acknowledge anyway to avoid retries
          }
        });

        await Promise.all(promises);
      } catch (error) {
        metrics.increment('silo.queue.errors', 1);
        getLogger().error({ error }, 'Queue processing error');
        throw error; // Allow retry
      }
    });
  }

  /**
   * Synchronously store small content items
   */
  async simplePut(data: SiloSimplePutInput): Promise<SiloSimplePutResponse> {
    return wrap({ operation: 'simplePut' }, async () => {
      try {
        // Validate input
        const validatedData = siloSimplePutSchema.parse(data);
        return await this.services.content.simplePut(validatedData);
      } catch (error) {
        if (error instanceof z.ZodError) {
          getLogger().error({ error: error.errors }, 'Validation error in simplePut');
          metrics.increment('silo.validation.errors', 1, { method: 'simplePut' });
          throw new Error(
            `Validation error: ${error.errors
              .map(e => `${e.path.join('.')}: ${e.message}`)
              .join(', ')}`,
          );
        }

        getLogger().error({ error }, 'Error in simplePut');
        metrics.increment('silo.rpc.errors', 1, { method: 'simplePut' });
        throw error;
      }
    });
  }

  /**
   * Generate pre-signed forms for direct browser-to-R2 uploads
   */
  async createUpload(data: SiloCreateUploadInput): Promise<SiloCreateUploadResponse> {
    return wrap({ operation: 'createUpload' }, async () => {
      try {
        // Validate input
        const validatedData = siloCreateUploadSchema.parse(data);
        return await this.services.content.createUpload(validatedData);
      } catch (error) {
        if (error instanceof z.ZodError) {
          getLogger().error({ error: error.errors }, 'Validation error in createUpload');
          metrics.increment('silo.validation.errors', 1, { method: 'createUpload' });
          throw new Error(
            `Validation error: ${error.errors
              .map(e => `${e.path.join('.')}: ${e.message}`)
              .join(', ')}`,
          );
        }

        getLogger().error({ error }, 'Error in createUpload');
        metrics.increment('silo.rpc.errors', 1, { method: 'createUpload' });
        throw error;
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

        getLogger().error({ error }, 'Error in batchGet');
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

        getLogger().error({ error }, 'Error in delete');
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

        getLogger().error({ error }, 'Error in stats');
        metrics.increment('silo.rpc.errors', 1, { method: 'stats' });
        throw error;
      }
    });
  }
}
