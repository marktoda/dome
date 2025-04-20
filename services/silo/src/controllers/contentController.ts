import { getLogger, metrics } from '@dome/logging';
import { ulid } from 'ulid';
import { R2Service } from '../services/r2Service';
import { MetadataService } from '../services/metadataService';
import { QueueService } from '../services/queueService';

/**
 * ContentController handles business logic for content operations
 * Coordinates between R2Service, MetadataService, and QueueService
 */
export class ContentController {
  constructor(
    private env: any,
    private r2Service: R2Service,
    private metadataService: MetadataService,
    private queueService: QueueService
  ) {}

  /**
   * Store small content items synchronously
   */
  async simplePut(data: {
    id?: string;
    contentType: string;
    content: string | ArrayBuffer;
    userId?: string;
    metadata?: Record<string, any>;
    acl?: { public?: boolean };
  }) {
    const startTime = Date.now();

    try {
      // Generate a unique ID if not provided
      const id = data.id || ulid();

      // Get user ID from data or set to null for public content
      const userId = data.userId || null;

      // Calculate content size
      const content = data.content;
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

      // Create custom metadata
      const customMetadata: Record<string, string> = {
        userId: userId || '',
        contentType: data.contentType,
      };

      // Add optional metadata if provided
      if (data.metadata) {
        customMetadata.metadata = JSON.stringify(data.metadata);
      }

      // Store content in R2 using R2Service
      await this.r2Service.putObject(r2Key, content, customMetadata);

      // Store metadata in D1 using MetadataService
      const now = Math.floor(Date.now() / 1000);

      await this.metadataService.insertMetadata({
        id,
        userId,
        contentType: data.contentType,
        size,
        r2Key,
        createdAt: now,
      });

      // Record metrics
      metrics.increment('silo.upload.bytes', size);
      metrics.timing('silo.db.write.latency_ms', Date.now() - startTime);

      getLogger().info({
        id,
        contentType: data.contentType,
        size
      }, 'Content stored successfully');

      return {
        id,
        contentType: data.contentType,
        size,
        createdAt: now
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
    acl?: { public?: boolean };
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

      getLogger().info({
        id: contentId,
        contentType: data.contentType,
        size: data.size,
        expirationSeconds
      }, 'Pre-signed POST policy created successfully');

      // Return the pre-signed URL, form fields, and content ID
      return {
        id: contentId,
        uploadUrl: presignedPost.url,
        formData: presignedPost.formData,
        expiresIn: expirationSeconds
      };
    } catch (error) {
      getLogger().error({ error }, 'Error in createUpload');
      metrics.increment('silo.rpc.errors', 1, { method: 'createUpload' });
      throw error;
    }
  }

  /**
   * Efficiently retrieve multiple content items
   */
  async batchGet(data: { ids: string[], userId?: string | null }) {
    // Validate input
    const ids = data.ids;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      throw new Error('Valid ids array is required');
    }
    const requestUserId = data.userId || null;
    
    // Fetch metadata from D1 using MetadataService
    const metadataItems = await this.metadataService.getMetadataByIds(ids);
    
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
      fetchPromises.push((async () => {
        const obj = await this.r2Service.getObject(item.r2Key);
        metrics.timing('silo.r2.get.latency_ms', Date.now() - startTime);
        if (obj && item.size <= 1024 * 1024) {
          results[item.id].body = await obj.text();
        } else {
          results[item.id].url = await this.r2Service.createPresignedUrl(item.r2Key, { expiresIn: 3600 });
        }
      })());
    }
    
    await Promise.all(fetchPromises);
    return { items: Object.values(results) };
  }

  /**
   * Delete content items
   * Implements deletion of content from R2 and metadata from D1 with ACL checks.
   */
  async delete(data: { id: string, userId?: string | null }) {
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
      deleted: true
    });
    
    metrics.increment('silo.rpc.delete.success', 1);
    getLogger().info({ id, userId: requestUserId }, 'Content deleted successfully');
    
    return { success: true };
  }
}

export function createContentController(
  env: any,
  r2Service: R2Service,
  metadataService: MetadataService,
  queueService: QueueService
): ContentController {
  return new ContentController(env, r2Service, metadataService, queueService);
}