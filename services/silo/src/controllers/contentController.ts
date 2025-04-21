import { getLogger, metrics } from '@dome/logging';
import { ulid } from 'ulid';
import { R2Service } from '../services/r2Service';
import { MetadataService } from '../services/metadataService';
import { QueueService } from '../services/queueService';
import { R2Event } from '../types';
import { SiloSimplePutResponse, SiloSimplePutInput, ContentType } from '@dome/common';

/**
 * ContentController handles business logic for content operations
 * Coordinates between R2Service, MetadataService, and QueueService
 */
export class ContentController {
  constructor(
    private env: any,
    private r2Service: R2Service,
    private metadataService: MetadataService,
    private queueService: QueueService,
  ) {}

  /**
   * Store small content items synchronously
   */
  async simplePut(data: SiloSimplePutInput): Promise<SiloSimplePutResponse> {
    const startTime = Date.now();

    try {
      // Add debug logging for the input data
      getLogger().info(
        {
          contentType: data.contentType,
          userId: data.userId,
          hasId: !!data.id,
          contentIsString: typeof data.content === 'string',
          contentLength:
            typeof data.content === 'string' ? data.content.length : data.content.byteLength,
          content: data.content,
          hasMetadata: !!data.metadata,
        },
        'simplePut input data',
      );

      // Generate a unique ID if not provided
      const id = data.id || ulid();

      // Get user ID from data or set to null for public content
      const userId = data.userId || null;

      // Calculate content size
      const content = data.content;
      const size =
        typeof content === 'string' ? new TextEncoder().encode(content).length : content.byteLength;

      // Check size limit (1MB for simplePut)
      const MAX_SIZE = 1024 * 1024; // 1MB
      if (size > MAX_SIZE) {
        throw new Error(
          `Content size exceeds maximum allowed size of 1MB. Use createUpload for larger files.`,
        );
      }

      // Create R2 key
      const r2Key = `content/${id}`;
      const contentType = data.contentType || 'note';

      // Create custom metadata
      const customMetadata: Record<string, string> = {
        userId: userId || '',
        contentType,
      };

      // Add optional metadata if provided
      if (data.metadata) {
        customMetadata.metadata = JSON.stringify(data.metadata);
      }

      // Store content in R2 using R2Service
      await this.r2Service.putObject(r2Key, content, customMetadata);

      // Note: We don't need to insert metadata here as it will be handled by the R2 event
      // that gets triggered automatically after the R2 object is created

      // Record metrics
      metrics.increment('silo.upload.bytes', size);

      const now = Math.floor(Date.now() / 1000);
      getLogger().info(
        {
          id,
          contentType,
          size,
        },
        'Content stored successfully',
      );

      return {
        id,
        contentType,
        size,
        createdAt: now,
      };
    } catch (error) {
      getLogger().error({ error }, 'Error in simplePut');
      metrics.increment('silo.rpc.errors', 1, { method: 'simplePut' });
      throw error;
    }
  }

  /**
   * Generate pre-signed forms for direct browser-to-R2 uploads
   */
  async createUpload(data: {
    contentType: string;
    size: number;
    metadata?: Record<string, any>;
    expirationSeconds?: number;
    sha256?: string;
    userId?: string;
  }) {
    const startTime = Date.now();

    try {
      // Generate a unique content ID
      const contentId = ulid();

      // Create R2 key with upload/ prefix to distinguish from direct simplePut uploads
      const r2Key = `upload/${contentId}`;

      // Get user ID from data or set to null for public content
      const userId = data.userId || null;

      // Check size limit (100 MiB max)
      const MAX_SIZE = 100 * 1024 * 1024; // 100 MiB
      if (data.size > MAX_SIZE) {
        throw new Error(`Content size exceeds maximum allowed size of 100 MiB.`);
      }

      // Use default expiration if not provided
      const expirationSeconds = data.expirationSeconds || 900; // Default 15 minutes

      // Prepare metadata for the upload
      const metadata: Record<string, string> = {
        'x-user-id': userId || '',
        'x-content-type': data.contentType,
      };

      // Add optional SHA256 hash if provided
      if (data.sha256) {
        metadata['x-sha256'] = data.sha256;
      }

      // Add custom metadata if provided
      if (data.metadata) {
        metadata['x-metadata'] = JSON.stringify(data.metadata);
      }

      // Create pre-signed POST policy using R2Service
      const presignedPost = await this.r2Service.createPresignedPost({
        key: r2Key,
        metadata,
        conditions: [
          ['content-length-range', 0, MAX_SIZE], // Enforce size limit
        ],
        expiration: expirationSeconds,
      });

      // Record metrics
      metrics.increment('silo.presigned_post.created', 1);
      metrics.timing('silo.presigned_post.latency_ms', Date.now() - startTime);

      getLogger().info(
        {
          id: contentId,
          contentType: data.contentType,
          size: data.size,
          expirationSeconds,
        },
        'Pre-signed POST policy created successfully',
      );

      // Return the pre-signed URL, form fields, and content ID
      return {
        id: contentId,
        uploadUrl: presignedPost.url,
        formData: presignedPost.formData,
        expiresIn: expirationSeconds,
      };
    } catch (error) {
      getLogger().error({ error }, 'Error in createUpload');
      metrics.increment('silo.rpc.errors', 1, { method: 'createUpload' });
      throw error;
    }
  }

  /**
   * Efficiently retrieve multiple content items
   * If ids array is empty, fetches all content for the given user
   */
  async batchGet(data: {
    ids?: string[];
    userId?: string | null;
    contentType?: string;
    limit?: number;
    offset?: number;
  }) {
    try {
      getLogger().info(
        {
          ids: data.ids,
          userId: data.userId,
          contentType: data.contentType,
          limit: data.limit,
          offset: data.offset,
        },
        'batchGet called',
      );

      const requestUserId = data.userId || null;
      const ids = data.ids || [];
      const contentType = data.contentType;
      const limit = data.limit || 50;
      const offset = data.offset || 0;

      let metadataItems: any[] = [];

      // If ids array is empty, fetch all content for the user
      if (ids.length === 0) {
        if (!requestUserId) {
          getLogger().warn('User ID is required when not providing specific content IDs');
          throw new Error('User ID is required when not providing specific content IDs');
        }

        getLogger().info(
          { requestUserId, contentType, limit, offset },
          'Fetching all content for user',
        );
        // Get metadata for all user content with pagination and filtering
        metadataItems = await this.metadataService.getMetadataByUserId(
          requestUserId,
          contentType,
          limit,
          offset,
        );
      } else {
        getLogger().info(
          { idsCount: ids.length, requestUserId },
          'Fetching metadata for specific IDs',
        );
        // Fetch metadata for specific IDs, filtering by userId if provided
        metadataItems = await this.metadataService.getMetadataByIds(ids);
      }

      getLogger().info({ metadataItemsCount: metadataItems.length }, 'Fetched metadata items');

      const results: Record<string, any> = {};
      const fetchPromises: Promise<void>[] = [];

      for (const item of metadataItems) {
        // ACL check
        if (item.userId !== null && item.userId !== requestUserId) {
          continue;
        }

        // Initialize result item
        results[item.id] = {
          id: item.id,
          userId: item.userId,
          contentType: item.contentType,
          size: item.size,
          createdAt: item.createdAt,
        };

        // Fetch content or generate URL using R2Service
        const startTime = Date.now();
        fetchPromises.push(
          (async () => {
            const obj = await this.r2Service.getObject(item.r2Key);
            getLogger().info(
              { itemId: item.id, latency: Date.now() - startTime },
              'Fetched R2 object',
            );
            metrics.timing('silo.r2.get.latency_ms', Date.now() - startTime);
            if (obj && item.size <= 1024 * 1024) {
              results[item.id].body = await obj.text();
            } else {
              results[item.id].url = await this.r2Service.createPresignedUrl(item.r2Key, {
                expiresIn: 3600,
              });
            }
          })(),
        );
      }

      await Promise.all(fetchPromises);

      // If this was a listing request (empty ids array), get the total count
      let total = metadataItems.length;
      if (ids.length === 0 && requestUserId) {
        total = await this.metadataService.getContentCountForUser(requestUserId, contentType);
      }

      getLogger().info(
        {
          itemsCount: Object.values(results).length,
          total,
        },
        'Returning batchGet results',
      );

      return {
        items: Object.values(results),
        total,
        limit,
        offset,
      };
    } catch (error) {
      getLogger().error(
        {
          error:
            error instanceof Error
              ? {
                  name: error.name,
                  message: error.message,
                  stack: error.stack,
                }
              : String(error),
          ids: data.ids,
          userId: data.userId,
          errorType: error instanceof Error ? error.constructor.name : typeof error,
        },
        'Error in batchGet',
      );

      // Return empty results instead of throwing
      return {
        items: [],
        total: 0,
        limit: data.limit || 50,
        offset: data.offset || 0,
      };
    }
  }

  /**
   * Delete content items
   * Implements deletion of content from R2 and metadata from D1 with ACL checks.
   */
  async delete(data: { id: string; userId?: string | null }) {
    const { id } = data;
    if (!id) {
      throw new Error('Valid id is required');
    }

    const requestUserId = data.userId || null;

    // Fetch content metadata using MetadataService
    const metadataResult = await this.metadataService.getMetadataById(id);
    if (!metadataResult) {
      throw new Error('Content not found');
    }

    if (metadataResult.userId !== requestUserId) {
      throw new Error('Unauthorized');
    }

    // Delete object from R2 using R2Service
    await this.r2Service.deleteObject(metadataResult.r2Key);

    // Delete from D1 using MetadataService
    await this.metadataService.deleteMetadata(id);

    // Notify deletion using QueueService
    await this.queueService.sendNewContentMessage({
      id,
      userId: requestUserId,
      deleted: true,
    });

    metrics.increment('silo.rpc.delete.success', 1);
    getLogger().info({ id, userId: requestUserId }, 'Content deleted successfully');

    return { success: true };
  }

  /**
   * Process an R2 event from the queue
   * This is called when an object is created in R2 via direct upload
   */
  async processR2Event(event: R2Event) {
    try {
      if (event.action !== 'PutObject') {
        getLogger().warn({ event }, 'Unsupported event action: ' + event.action);
        return null;
      }

      const { key } = event.object;
      getLogger().info({ key }, 'Processing R2 PutObject event');

      // Get object metadata from R2
      const obj = await this.r2Service.headObject(key);
      if (!obj) {
        getLogger().warn({ key }, 'Object not found in R2');
        return null;
      }

      // Extract metadata from R2 object
      const userId = obj.customMetadata?.['x-user-id'] || obj.customMetadata?.userId || null;
      const contentType =
        obj.customMetadata?.['x-content-type'] ||
        obj.customMetadata?.contentType ||
        'application/octet-stream';
      const sha256 = obj.customMetadata?.['x-sha256'] || null;

      // Parse any additional metadata if present
      let metadata = null;
      if (obj.customMetadata?.['x-metadata'] || obj.customMetadata?.metadata) {
        try {
          metadata = JSON.parse(
            obj.customMetadata?.['x-metadata'] || obj.customMetadata?.metadata || '{}',
          );
        } catch (e) {
          getLogger().warn({ error: e }, 'Failed to parse metadata');
        }
      }

      // Generate a content ID from the key
      // For uploads, the key format is upload/{id}, so we extract the ID
      // For direct puts, the key format is content/{id}
      const id = key.startsWith('upload/')
        ? key.substring(7)
        : key.startsWith('content/')
        ? key.substring(8)
        : key;

      // Store metadata in D1
      const now = Math.floor(Date.now() / 1000);
      await this.metadataService.insertMetadata({
        id,
        userId,
        contentType,
        size: obj.size,
        r2Key: key,
        sha256,
        createdAt: now,
      });

      // Notify about new content
      await this.queueService.sendNewContentMessage({
        id,
        userId,
        contentType,
        size: obj.size,
        createdAt: now,
        metadata,
      });

      metrics.increment('silo.r2.events.processed', 1);
      getLogger().info({ id, key, contentType, size: obj.size }, 'R2 event processed successfully');

      return {
        id,
        contentType,
        size: obj.size,
        createdAt: now,
      };
    } catch (error) {
      metrics.increment('silo.r2.events.errors', 1);
      getLogger().error({ error, event }, 'Error processing R2 event');
      throw error;
    }
  }
}

export function createContentController(
  env: any,
  r2Service: R2Service,
  metadataService: MetadataService,
  queueService: QueueService,
): ContentController {
  return new ContentController(env, r2Service, metadataService, queueService);
}
