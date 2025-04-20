/**
 * Silo Service entrypoint
 *
 * This is the main entry point for the Silo service, implementing a WorkerEntrypoint
 * class that handles both RPC methods and queue processing.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { getLogger, metrics } from '@dome/logging';
import { NotImplementedError } from '@dome/common';
import { R2Event } from './types';
import { wrap } from './utils/wrap';
import { createServices, Services } from './services';

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
    await wrap(
      { op: 'queue', size: batch.messages.length, ...this.env },
      async () => {
        try {
          await this.services.queue.processBatch(batch);
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
  async simplePut(data: any) {
    return wrap({ operation: 'simplePut' }, async () => {
      try {
        return await this.services.content.simplePut(data);
      } catch (error) {
        getLogger().error({ error }, 'Error in simplePut');
        metrics.increment('silo.rpc.errors', 1, { method: 'simplePut' });
        throw error;
      }
    });
  }

  /**
   * Generate pre-signed forms for direct browser-to-R2 uploads
   */
  async createUpload(data: any) {
    return wrap({ operation: 'createUpload' }, async () => {
      try {
        return await this.services.content.createUpload(data);
      } catch (error) {
        getLogger().error({ error }, 'Error in createUpload');
        metrics.increment('silo.rpc.errors', 1, { method: 'createUpload' });
        throw error;
      }
    });
  }

  /**
   * Efficiently retrieve multiple content items
   */
  async batchGet(data: any) {
    return wrap({ operation: 'batchGet' }, async () => {
      try {
        return await this.services.content.batchGet(data);
      } catch (error) {
        getLogger().error({ error }, 'Error in batchGet');
        metrics.increment('silo.rpc.errors', 1, { method: 'batchGet' });
        throw error;
      }
    });
  }

  /**
   * Delete content items
   */
  async delete(data: any) {
    return wrap({ operation: 'delete', id: data.id }, async () => {
      try {
        return await this.services.content.delete(data);
      } catch (error) {
        getLogger().error({ error }, 'Error in delete');
        metrics.increment('silo.rpc.errors', 1, { method: 'delete' });
        throw error;
      }
    });
  }

  /**
   * Get storage statistics
   */
  async stats(data: any) {
    return wrap({ operation: 'stats' }, async () => {
      try {
        return await this.services.stats.getStats();
      } catch (error) {
        getLogger().error({ error }, 'Error in stats');
        metrics.increment('silo.rpc.errors', 1, { method: 'stats' });
        throw error;
      }
    });
  }
}
