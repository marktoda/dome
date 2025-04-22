import { getLogger } from '@dome/logging';
import { PUBLIC_USER_ID } from '@dome/common';
import { MetadataService } from './metadataService';

/**
 * SiloService - Core service for Silo functionality
 *
 * This service provides high-level operations for the Silo service,
 * including handling public content.
 */
export class SiloService {
  /**
   * Reference to the public user ID constant
   * This is used to identify content that should be accessible to all users
   */
  public static readonly PUBLIC_USER_ID = PUBLIC_USER_ID;

  constructor(private readonly metadataService: MetadataService) {}

  /**
   * Determines if a userId represents public content
   * @param userId The user ID to check
   * @returns True if the userId represents public content
   */
  public static isPublicContent(userId: string | null): boolean {
    return userId === SiloService.PUBLIC_USER_ID || userId === null || userId === '';
  }

  /**
   * Normalizes a userId, converting null or empty strings to the public user ID
   * @param userId The user ID to normalize
   * @returns The normalized user ID
   */
  public static normalizeUserId(userId: string | null): string {
    return SiloService.isPublicContent(userId) ? SiloService.PUBLIC_USER_ID : (userId as string);
  }

  /**
   * Fetches content metadata, including both user-specific and public content
   * @param userId The user ID to fetch content for
   * @param category Optional category filter
   * @param limit Maximum number of items to return
   * @param offset Pagination offset
   * @returns Array of content metadata
   */
  async fetchContentForUser(
    userId: string,
    category?: string,
    limit: number = 50,
    offset: number = 0,
  ) {
    getLogger().info({ userId, category, limit, offset }, 'Fetching content for user');

    // First get user-specific content
    const userContent = await this.metadataService.getMetadataByUserId(
      userId,
      category,
      limit,
      offset,
    );

    // Then get public content
    const publicContent = await this.metadataService.getMetadataByUserId(
      SiloService.PUBLIC_USER_ID,
      category,
      limit,
      offset,
    );

    // Combine and sort by creation date (newest first)
    const combined = [...userContent, ...publicContent].sort((a, b) => b.createdAt - a.createdAt);

    // Apply pagination to the combined results
    return combined.slice(0, limit);
  }
}

/**
 * Factory function to create a new SiloService
 * @param metadataService The metadata service to use
 * @returns A new SiloService instance
 */
export function createSiloService(metadataService: MetadataService): SiloService {
  return new SiloService(metadataService);
}
