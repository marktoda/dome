import { getLogger, logError, metrics } from '@dome/common';

/**
 * R2Service - A wrapper around R2 for content storage operations
 * This service encapsulates all interactions with the R2 storage service
 */
export class R2Service {
  constructor(private env: any) {}

  /**
   * Store content in R2
   * @param key The R2 key to store the content under
   * @param content The content to store
   * @param metadata Custom metadata to store with the content
   */
  async putObject(
    key: string,
    content: string | ArrayBuffer,
    metadata: Record<string, string> = {},
  ) {
    const startTime = Date.now();

    try {
      // Add debug logging for the content being stored
      getLogger().info(
        {
          key,
          contentIsString: typeof content === 'string',
          contentLength: typeof content === 'string' ? content.length : content.byteLength,
          contentPreview:
            typeof content === 'string'
              ? `${content.substring(0, 50)}${content.length > 50 ? '...' : ''}`
              : '[Binary data]',
          metadataKeys: Object.keys(metadata),
        },
        'putObject input data',
      );

      // Store in R2 with custom metadata
      await this.env.BUCKET.put(key, content, {
        httpMetadata: {
          contentType: 'application/octet-stream',
        },
        customMetadata: metadata,
      });

      metrics.timing('silo.r2.put.latency_ms', Date.now() - startTime);
      getLogger().debug(
        {
          key,
          size:
            typeof content === 'string'
              ? new TextEncoder().encode(content).length
              : content.byteLength,
        },
        'Content stored in R2',
      );

      return true;
    } catch (error) {
      metrics.increment('silo.r2.errors', 1, { operation: 'put' });
      logError(error, 'Error storing content in R2', { key });
      throw error;
    }
  }

  /**
   * Retrieve content from R2
   * @param key The R2 key to retrieve
   */
  async getObject(key: string) {
    const startTime = Date.now();

    try {
      const object = await this.env.BUCKET.get(key);

      metrics.timing('silo.r2.get.latency_ms', Date.now() - startTime);

      if (!object) {
        getLogger().warn({ key }, 'Object not found in R2');
        return null;
      }

      return object;
    } catch (error) {
      metrics.increment('silo.r2.errors', 1, { operation: 'get' });
      logError(error, 'Error retrieving content from R2', { key });
      throw error;
    }
  }

  /**
   * Delete content from R2
   * @param key The R2 key to delete
   */
  async deleteObject(key: string) {
    const startTime = Date.now();

    try {
      await this.env.BUCKET.delete(key);

      metrics.timing('silo.r2.delete.latency_ms', Date.now() - startTime);
      getLogger().debug({ key }, 'Content deleted from R2');

      return true;
    } catch (error) {
      metrics.increment('silo.r2.errors', 1, { operation: 'delete' });
      logError(error, 'Error deleting content from R2', { key });
      throw error;
    }
  }

  /**
   * Get object metadata from R2
   * @param key The R2 key to get metadata for
   */
  async headObject(key: string) {
    const startTime = Date.now();

    try {
      const object = await this.env.BUCKET.head(key);

      metrics.timing('silo.r2.head.latency_ms', Date.now() - startTime);

      if (!object) {
        getLogger().warn({ key }, 'Object not found in R2');
        return null;
      }

      return object;
    } catch (error) {
      metrics.increment('silo.r2.errors', 1, { operation: 'head' });
      logError(error, 'Error getting object metadata from R2', { key });
      throw error;
    }
  }
}

export function createR2Service(env: any): R2Service {
  return new R2Service(env);
}
