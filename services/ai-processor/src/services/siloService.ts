import { getLogger } from '@dome/logging';
import { SiloBatchGetInput, SiloBatchGetResponse } from '@dome/common';
import { SiloBinding } from '../types';

/**
 * Service for interacting with the Silo service
 * Provides methods to fetch content from Silo
 */
export class SiloService {
  constructor(private readonly silo: SiloBinding) {}

  /**
   * Fetch content from Silo by ID
   * @param contentId The ID of the content to fetch
   * @param userId The ID of the user who owns the content (optional)
   * @returns The content as a string
   */
  async fetchContent(contentId: string, userId: string | null): Promise<string> {
    try {
      getLogger().debug({ contentId, userId }, 'Fetching content from Silo');

      // Use the batchGet method to fetch the content
      const result = await this.silo.batchGet({ ids: [contentId], userId });

      if (!result.items || result.items.length === 0) {
        getLogger().error({ contentId, userId }, 'Content not found in Silo');
        throw new Error(`Content not found: ${contentId}`);
      }

      const item = result.items[0];

      // Check if the content body is available
      if (!item.body) {
        getLogger().error({ contentId, userId, hasUrl: !!item.url }, 'Content body not available');

        if (item.url) {
          // If a URL is available, we could potentially fetch the content
          // from the URL, but for now we'll throw an error
          throw new Error(`Content body not available for: ${contentId} (URL available)`);
        }

        throw new Error(`Content body not available for: ${contentId}`);
      }

      getLogger().info(
        {
          contentId,
          userId,
          category: item.category,
          mimeType: item.mimeType,
          contentSize: item.body.length,
        },
        'Successfully fetched content from Silo',
      );

      return item.body;
    } catch (error) {
      getLogger().error(
        {
          error: error instanceof Error ? error.message : String(error),
          contentId,
          userId,
        },
        'Error fetching content from Silo',
      );
      throw error;
    }
  }
}

/**
 * Create a new Silo service instance
 * @param env The environment bindings
 * @returns A new Silo service instance
 */
export function createSiloService(env: Env): SiloService {
  return new SiloService(env.SILO as unknown as SiloBinding);
}
