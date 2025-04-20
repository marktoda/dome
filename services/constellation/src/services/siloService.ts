import { getLogger, metrics } from '@dome/logging';
import { z } from 'zod';
import { SiloEmbedJob, ContentType, NewContentMessageSchema, NewContentMessage } from '@dome/common';
import { SiloService as SiloBinding } from '../types';

/**
 * Service for interacting with the Silo service
 * Provides methods to fetch content from Silo
 */
export class SiloService {
  private silo: SiloBinding;
  /**
   * Create a new SiloService
   * @param env The environment bindings
   */
  constructor(private env: Env) {
    this.silo = env.SILO as unknown as SiloBinding;
  }

  /**
   * Fetch content from Silo by ID
   * @param contentId The ID of the content to fetch
   * @param userId The ID of the user who owns the content
   * @returns The content as a string
   */
  async fetchContent(contentId: string, userId: string | null): Promise<string> {
    const startTime = Date.now();

    try {
      // Use the fetch method to make an RPC call to the batchGet method
      const result = await this.silo.batchGet({ ids: [contentId], userId });

      if (!result.items || result.items.length === 0) {
        getLogger().error({ contentId, userId }, 'Content not found');
        throw new Error(`Content not found: ${contentId}`);
      }

      const item = result.items[0];

      // Check if the content body is available
      if (!item.body) {
        getLogger().error({ contentId, userId }, 'Content body not available');
        throw new Error(`Content body not available for: ${contentId}`);
      }

      metrics.timing('constellation.silo.fetch.latency_ms', Date.now() - startTime);
      return item.body;
    } catch (error) {
      metrics.increment('constellation.silo.fetch.errors', 1);
      getLogger().error({ error, contentId, userId }, 'Error fetching content from Silo');
      throw error;
    }
  }

  /**
   * Convert a message from the new-content queue to a SiloEmbedJob
   * @param message The message from the new-content queue
   * @returns A SiloEmbedJob
   */
  async convertToEmbedJob(message: NewContentMessage): Promise<SiloEmbedJob> {
    try {
      // The message is already typed as NewContentMessage, but we still validate
      // to ensure runtime safety
      const validatedMessage = NewContentMessageSchema.parse(message);

      // Skip deleted content
      if (validatedMessage.deleted) {
        throw new Error('Content is marked as deleted, skipping embedding');
      }

      // Fetch the content from Silo
      const text = await this.fetchContent(validatedMessage.id, validatedMessage.userId);
      getLogger().info({ contentId: validatedMessage.id, userId: validatedMessage.userId }, 'Fetched content from Silo');

      // Create a SiloEmbedJob
      return {
        userId: validatedMessage.userId || '',
        contentId: validatedMessage.id,
        text,
        created: (validatedMessage.createdAt || Math.floor(Date.now() / 1000)) * 1000, // Convert seconds to milliseconds
        version: 1, // Default version
        contentType: validatedMessage.contentType as ContentType || 'note'
      };
    } catch (error) {
      if (error instanceof z.ZodError) {
        getLogger().error({
          error: error.errors,
          message
        }, 'Invalid message format from new-content queue');
      } else {
        getLogger().error({ error: JSON.stringify(error), message }, 'Error converting message to embed job');
      }
      throw error;
    }
  }
}

/**
 * Create a new SiloService
 * @param env The environment bindings
 * @returns A new SiloService
 */
export function createSiloService(env: Env): SiloService {
  return new SiloService(env);
}
