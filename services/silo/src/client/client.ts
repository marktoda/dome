import {
  SiloSimplePutInput,
  SiloSimplePutResponse,
  SiloBatchGetInput,
  SiloContentBatch,
  SiloDeleteInput,
  SiloDeleteResponse,
  SiloStatsResponse,
  SiloContentItem,
  SiloContentMetadata,
  siloSimplePutSchema,
} from '@dome/common';
import { getLogger, logError, metrics } from '@dome/common';
import { SiloBinding } from '../types';
export { SiloBinding } from '../types';
import { ulid } from 'ulid';
import { Queue } from '@dome/common/queue';
import { IngestQueue } from '../queues/IngestQueue';

// Maximum message size for the queue in bytes
const MAX_QUEUE_MESSAGE_SIZE = 120000;

/**
 * Client for the silo service
 * Provides methods for interacting with the Silo service
 */
export class SiloClient {
  private readonly PUBLIC_USER_ID = 'public';
  private readonly queue?: IngestQueue;

  /**
   * Create a new SiloClient
   * @param binding The Cloudflare Worker binding to the Silo service
   * @param metricsPrefix Optional prefix for metrics (defaults to 'silo.client')
   */
  constructor(
    private readonly binding: SiloBinding,
    queueBinding?: Queue,
    private readonly metricsPrefix: string = 'silo.client',
  ) {
    this.queue = queueBinding ? new IngestQueue(queueBinding) : undefined;
  }

  /**
   * Upload multiple content items to Silo
   *
   * @param contents - Array of content items to upload
   * @returns Array of content IDs
   */
  async upload(contents: SiloSimplePutInput[]): Promise<string[]> {
    const results = await Promise.all(contents.map(c => this.uploadSingle(c)));
    return results.map(r => r.id);
  }

  /**
   * Upload a single content item to Silo via the ingest queue
   *
   * @param content - Content item to upload
   * @returns Content ID and metadata
   * @throws Error if the upload fails
   */
  async uploadSingle(content: SiloSimplePutInput): Promise<SiloSimplePutResponse> {
    if (!this.queue) {
      throw new Error('Queue is not available for upload');
    }

    const logger = getLogger();
    const id = content.id || ulid();
    const createdAt = Math.floor(Date.now() / 1000);

    // Create a message for the ingest queue
    const message = siloSimplePutSchema.parse({
      id,
      userId: content.userId || undefined,
      content: content.content,
      category: content.category || 'note',
      mimeType: content.mimeType || 'text/markdown',
      metadata: content.metadata,
    });

    // Calculate the size of the content
    const contentSize =
      typeof content.content === 'string'
        ? new TextEncoder().encode(content.content).length
        : content.content.byteLength;

    // Extract file path information from metadata if available
    const filePath = content.metadata?.filePath || content.metadata?.path || 'unknown';
    const fileName =
      content.metadata?.fileName ||
      content.metadata?.name ||
      (typeof filePath === 'string' ? filePath.split('/').pop() : 'unknown');

    // Check if the message exceeds the maximum size
    if (contentSize > MAX_QUEUE_MESSAGE_SIZE) {
      logger.warn(
        {
          event: 'queue_message_skipped',
          contentId: id,
          contentSize,
          maxSize: MAX_QUEUE_MESSAGE_SIZE,
          category: content.category || 'note',
          mimeType: content.mimeType || 'text/markdown',
          filePath,
          fileName,
        },
        `Queue message skipped: content exceeds maximum size limit (file: ${filePath})`,
      );
    } else {
      try {
        // Send the message to the ingest queue
        await this.queue.send(message);
      } catch (e) {
        logError(e, 'Queue send error');
        logger.warn(
          {
            error: e,
            event: 'queue_message_skipped',
            contentId: id,
            contentSize,
            maxSize: MAX_QUEUE_MESSAGE_SIZE,
            category: content.category || 'note',
            mimeType: content.mimeType || 'text/markdown',
            filePath,
            fileName,
          },
          `Queue message skipped: Queue send failed`,
        );
      }

      logger.info(
        {
          event: 'queue_message_sent',
          contentId: id,
          contentSize,
          category: content.category || 'note',
          mimeType: content.mimeType || 'text/markdown',
          filePath,
          fileName,
        },
        `Successfully published message to ingest queue (file: ${filePath})`,
      );
    }

    // Return a response with the ID
    return {
      id,
      category: content.category || 'note',
      mimeType: content.mimeType || 'text/markdown',
      size: contentSize,
      createdAt,
    };
  }

  /**
   * Retrieve multiple items by id or list a user's content with pagination
   * @param params Query parameters
   * @returns Promise resolving to the batch get response
   */
  async get(contentId: string, userId?: string | null): Promise<SiloContentItem> {
    const result = await this.batchGet({ ids: [contentId], userId });

    if (!result.items || result.items.length === 0) {
      getLogger().error({ contentId, userId }, 'Content not found');
      throw new Error(`Content not found: ${contentId}`);
    }

    return result.items[0];
  }

  /**
   * Retrieve multiple items by id or list a user's content with pagination
   * @param params Query parameters
   * @returns Promise resolving to the batch get response
   */
  async batchGet(params: SiloBatchGetInput): Promise<SiloContentBatch> {
    const startTime = performance.now();
    try {
      getLogger().info(
        {
          ids: params.ids,
          userId: params.userId,
          category: params.category,
          limit: params.limit,
          offset: params.offset,
        },
        'Fetching content from Silo',
      );

      const result = await this.binding.batchGet(params);

      metrics.increment(`${this.metricsPrefix}.batchGet.success`);
      metrics.timing(`${this.metricsPrefix}.batchGet.latency_ms`, performance.now() - startTime);

      return result;
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.batchGet.errors`);
      logError(error, 'Error fetching content from Silo');
      throw error;
    }
  }

  /**
   * Delete a content item (object + metadata) with ACL checks
   * @param params Delete parameters
   * @returns Promise resolving to the delete response
   */
  async delete(params: SiloDeleteInput): Promise<SiloDeleteResponse> {
    const startTime = performance.now();
    try {
      getLogger().info(
        {
          id: params.id,
          userId: params.userId,
        },
        'Deleting content from Silo',
      );

      const result = await this.binding.delete(params);

      metrics.increment(`${this.metricsPrefix}.delete.success`);
      metrics.timing(`${this.metricsPrefix}.delete.latency_ms`, performance.now() - startTime);

      return result;
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.delete.errors`);
      logError(error, 'Error deleting content from Silo');
      throw error;
    }
  }

  /**
   * Find content with null or "Content processing failed" summaries
   * @returns Promise resolving to an array of content metadata
   */
  async findContentWithFailedSummary(): Promise<SiloContentMetadata[]> {
    const startTime = performance.now();
    try {
      getLogger().info('Finding content with failed summaries');

      const result = await this.binding.findContentWithFailedSummary();

      metrics.increment(`${this.metricsPrefix}.findContentWithFailedSummary.success`);
      metrics.timing(
        `${this.metricsPrefix}.findContentWithFailedSummary.latency_ms`,
        performance.now() - startTime,
      );

      return result;
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.findContentWithFailedSummary.errors`);
      logError(error, 'Error finding content with failed summaries');
      throw error;
    }
  }

  /**
   * Get metadata for a specific content by ID
   * @param id Content ID
   * @returns Promise resolving to the content metadata
   */
  async getMetadataById(id: string): Promise<SiloContentMetadata | null> {
    const startTime = performance.now();
    try {
      getLogger().info({ id }, 'Getting content metadata by ID');

      const result = await this.binding.getMetadataById(id);

      metrics.increment(`${this.metricsPrefix}.getMetadataById.success`);
      metrics.timing(
        `${this.metricsPrefix}.getMetadataById.latency_ms`,
        performance.now() - startTime,
      );

      return result;
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.getMetadataById.errors`);
      logError(error, 'Error getting content metadata by ID', { id });
      throw error;
    }
  }

  /**
   * Get storage statistics
   * @returns Promise resolving to the stats response
   */
  async stats(): Promise<SiloStatsResponse> {
    const startTime = performance.now();
    try {
      getLogger().info('Fetching Silo storage statistics');

      const result = await this.binding.stats({});

      metrics.increment(`${this.metricsPrefix}.stats.success`);
      metrics.timing(`${this.metricsPrefix}.stats.latency_ms`, performance.now() - startTime);

      return result;
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.stats.errors`);
      logError(error, 'Error fetching Silo storage statistics');
      throw error;
    }
  }

  /**
   * Reprocess content items by IDs to re-publish to constellation and ai-processor services
   * @param contentIds Array of content IDs to reprocess
   * @returns Promise resolving to the reprocess response with count of reprocessed items
   */
  async reprocessContent(contentIds: string[]): Promise<{ reprocessed: number }> {
    const startTime = performance.now();
    try {
      getLogger().info({ contentIds, count: contentIds.length }, 'Reprocessing content items');

      const result = await this.binding.reprocessContent(contentIds);

      metrics.increment(`${this.metricsPrefix}.reprocessContent.success`);
      metrics.timing(
        `${this.metricsPrefix}.reprocessContent.latency_ms`,
        performance.now() - startTime,
      );
      metrics.gauge(`${this.metricsPrefix}.reprocessContent.count`, result.reprocessed);

      return result;
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.reprocessContent.errors`);
      logError(error, 'Error reprocessing content items', { contentCount: contentIds.length });
      throw error;
    }
  }

  /**
   * Normalize a user ID
   * @param userId The user ID to normalize
   * @returns The normalized user ID
   */
  normalizeUserId(userId: string | null): string {
    return userId === null || userId === '' ? this.PUBLIC_USER_ID : userId;
  }

  /**
   * Calculate the size of content
   * @param content The content to calculate the size of
   * @returns The size of the content in bytes
   */
  private contentSize(content: string | ArrayBuffer): number {
    return typeof content === 'string'
      ? new TextEncoder().encode(content).length
      : content.byteLength;
  }
}

/**
 * Create a new SiloClient
 * @param binding The Cloudflare Worker binding to the Silo service
 * @param metricsPrefix Optional prefix for metrics (defaults to 'silo.client')
 * @returns A new SiloClient instance
 */
export function createSiloClient(
  binding: SiloBinding,
  queue: Queue,
  metricsPrefix?: string,
): SiloClient {
  return new SiloClient(binding, queue, metricsPrefix);
}
