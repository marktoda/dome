/**
 * Silo Service entrypoint
 *
 * This is the main entry point for the Silo service, implementing a WorkerEntrypoint
 * class that handles both RPC methods and queue processing.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { withLogger, getLogger, metrics } from '@dome/logging';
import { NotImplementedError } from '@dome/common';
import { R2Event } from './types';
import { ulid } from 'ulid';
import { drizzle } from 'drizzle-orm/d1';
import { contents } from './db/schema';
import { simplePutSchema, createUploadSchema, SimplePutInput, CreateUploadInput } from './models';
async function wrap<T>(meta: Record<string, unknown>, fn: () => Promise<T>) {
  return withLogger(Object.assign({}, meta, { service: 'silo' }), async () => {
    try {
      return await fn();
    } catch (err) {
      getLogger().error({ err }, 'Unhandled error');
      throw err;
    }
  });
}

/**
 * Silo service main class
 */
export default class Silo extends WorkerEntrypoint<Env> {
  /**
   * Queue consumer for processing R2 object-created events
   * Will be fully implemented in Stage 5
   */
  async queue(batch: MessageBatch<unknown>) {
    await wrap(
      { op: 'queue', size: batch.messages.length, ...this.env },
      async () => {
        try {
          getLogger().info(
            {
              service: 'silo',
              operation: 'queue',
              batchSize: batch.messages.length
            },
            'Processing queue batch'
          );

          metrics.gauge('silo.queue.batch_size', batch.messages.length);

          // In Stage 2, we just log that we received the batch
          // Full implementation will be added in Stage 5
          getLogger().info({ batchSize: batch.messages.length }, 'Queue consumer not yet implemented');
        } catch (error) {
          metrics.increment('silo.queue.errors', 1);
          getLogger().error({ error }, 'Queue processing error');
          throw error; // Allow retry
        }
      });
  }

  /**
   * Synchronously store small content items
   * Will be implemented in Stage 3
   */
  async simplePut(data: any) {
    return wrap({ operation: 'simplePut' }, async () => {
      const startTime = Date.now();

      try {
        // Validate input using Zod schema from models
        const validatedData = simplePutSchema.parse(data);

        // Generate a unique ID if not provided
        const id = validatedData.id || ulid();

        // Get user ID from data or set to null for public content
        const userId = validatedData.userId || null;

        // Calculate content size
        const content = validatedData.content;
        const size = typeof content === 'string'
          ? new TextEncoder().encode(content).length
          : content.byteLength;

        // Check size limit (1MB for simplePut)
        const MAX_SIZE = 1024 * 1024; // 1MB
        if (size > MAX_SIZE) {
          throw new Error(`Content size exceeds maximum allowed size of 1MB. Use createUpload for larger files.`);
        }

        // Create R2 key
        const r2Key = `content/${id}`;

        // Store content in R2
        // Create custom headers
        const customHeaders = new Headers();
        customHeaders.set('x-user-id', userId || '');
        customHeaders.set('x-content-type', validatedData.contentType);
        if (validatedData.metadata) {
          customHeaders.set('x-metadata', JSON.stringify(validatedData.metadata));
        }
        
        // Store in R2 with custom metadata
        await this.env.BUCKET.put(r2Key, content, {
          httpMetadata: {
            contentType: 'application/octet-stream',
          },
          customMetadata: {
            userId: userId || '',
            contentType: validatedData.contentType,
            ...(validatedData.metadata ? { metadata: JSON.stringify(validatedData.metadata) } : {})
          }
        });

        // Store metadata in D1 using Drizzle
        const db = drizzle(this.env.DB);
        const now = Math.floor(Date.now() / 1000);

        await db.insert(contents).values({
          id,
          userId,
          contentType: validatedData.contentType,
          size,
          r2Key,
          createdAt: now,
          version: 1
        });

        // Record metrics
        metrics.increment('silo.upload.bytes', size);
        metrics.timing('silo.db.write.latency_ms', Date.now() - startTime);

        getLogger().info({
          id,
          contentType: validatedData.contentType,
          size
        }, 'Content stored successfully');

        return {
          id,
          contentType: validatedData.contentType,
          size,
          createdAt: now
        };
      } catch (error) {
        getLogger().error({ error }, 'Error in simplePut');
        metrics.increment('silo.rpc.errors', 1, { method: 'simplePut' });
        throw error;
      }
    });
  }

  /**
   * Generate pre-signed forms for direct browser-to-R2 uploads
   * Will be implemented in Stage 4
   */
  async createUpload(data: any) {
    return wrap({ operation: 'createUpload' }, async () => {
      const startTime = Date.now();

      try {
        // Validate input using Zod schema from models
        const validatedData = createUploadSchema.parse(data);

        // Generate a unique content ID
        const contentId = ulid();

        // Create R2 key with upload/ prefix to distinguish from direct simplePut uploads
        const r2Key = `upload/${contentId}`;

        // Get user ID from data or set to null for public content
        const userId = validatedData.userId || null;

        // Check size limit (100 MiB max)
        const MAX_SIZE = 100 * 1024 * 1024; // 100 MiB
        if (validatedData.size > MAX_SIZE) {
          throw new Error(`Content size exceeds maximum allowed size of 100 MiB.`);
        }

        // Prepare metadata for the upload
        const metadata: Record<string, string> = {
          'x-user-id': userId || '',
          'x-content-type': validatedData.contentType,
        };

        // Add optional SHA256 hash if provided
        if (validatedData.sha256) {
          metadata['x-sha256'] = validatedData.sha256;
        }

        // Add custom metadata if provided
        if (validatedData.metadata) {
          metadata['x-metadata'] = JSON.stringify(validatedData.metadata);
        }

        // Create pre-signed POST policy
        // Note: Using type assertion as createPresignedPost is not in the type definitions
        const presignedPost = await (this.env.BUCKET as any).createPresignedPost({
          key: r2Key,
          metadata,
          conditions: [
            ['content-length-range', 0, MAX_SIZE], // Enforce size limit
          ],
          expiration: validatedData.expirationSeconds, // Use the validated expiration time
        });

        // Record metrics
        metrics.increment('silo.presigned_post.created', 1);
        metrics.timing('silo.presigned_post.latency_ms', Date.now() - startTime);

        getLogger().info({
          id: contentId,
          contentType: validatedData.contentType,
          size: validatedData.size,
          expirationSeconds: validatedData.expirationSeconds
        }, 'Pre-signed POST policy created successfully');

        // Return the pre-signed URL, form fields, and content ID
        return {
          id: contentId,
          uploadUrl: presignedPost.url,
          formData: presignedPost.formData,
          expiresIn: validatedData.expirationSeconds
        };
      } catch (error) {
        getLogger().error({ error }, 'Error in createUpload');
        metrics.increment('silo.rpc.errors', 1, { method: 'createUpload' });
        throw error;
      }
    });
  }

  /**
   * Efficiently retrieve multiple content items
   * Will be implemented in Stage 6
   */
  async batchGet(data: any) {
    return wrap({ operation: 'batchGet' }, async () => {
      getLogger().info({ method: 'batchGet' }, 'Method not yet implemented');
      metrics.increment('silo.rpc.not_implemented', 1, { method: 'batchGet' });
      throw new NotImplementedError('batchGet method will be implemented in Stage 6');
    });
  }

  /**
   * Delete content items
   * Will be implemented in Stage 7
   */
  async delete(data: any) {
    return wrap({ operation: 'delete' }, async () => {
      getLogger().info({ method: 'delete' }, 'Method not yet implemented');
      metrics.increment('silo.rpc.not_implemented', 1, { method: 'delete' });
      throw new NotImplementedError('delete method will be implemented in Stage 7');
    });
  }

  /**
   * Get storage statistics
   * Will be implemented in Stage 7
   */
  async stats(data: any) {
    return wrap({ operation: 'stats' }, async () => {
      getLogger().info({ method: 'stats' }, 'Method not yet implemented');
      metrics.increment('silo.rpc.not_implemented', 1, { method: 'stats' });
      throw new NotImplementedError('stats method will be implemented in Stage 7');
    });
  }
}
