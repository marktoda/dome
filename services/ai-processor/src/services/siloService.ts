import { getLogger } from '@dome/logging';
import { SiloBinding, SiloBatchGetResponse } from '../types';

/**
 * Service for interacting with the Silo service
 * Provides methods to fetch content from Silo
 */
export class SiloService {
  constructor(private silo: SiloBinding) {}

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
          contentType: item.contentType,
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
 * @param silo The Silo binding
 * @returns A new Silo service instance
 */
export function createSiloService(silo: SiloBinding): SiloService {
  return new SiloService(silo);
}
