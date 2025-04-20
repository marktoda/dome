import { Bindings } from '../types';
import { ServiceError } from '@dome/common';
import { getLogger } from '@dome/logging';
import {
  ContentType,
  SiloSimplePutInput,
  SiloCreateUploadInput,
  SiloBatchGetInput,
  SiloDeleteInput,
  SiloStatsInput,
  SiloSimplePutResponse,
  SiloCreateUploadResponse,
  SiloBatchGetResponse,
  SiloBatchGetItem,
  SiloDeleteResponse,
  SiloStatsResponse
} from '@dome/common';
import { contentMapperService } from './contentMapperService';

/**
 * Service for interacting with the Silo content storage service
 * This service handles all content operations and is the single point of contact
 * with the Silo service for storing and retrieving content.
 */
export class SiloService {
  private logger = getLogger();

  /**
   * Store content directly using the simple put API
   *
   * @param env - Cloudflare Workers environment bindings
   * @param data - Simple put request data (legacy format)
   * @returns Promise resolving to the simple put response
   */
  async simplePut(
    env: Bindings,
    data: SiloSimplePutInput,
  ): Promise<SiloSimplePutResponse> {
    return env.SILO.simplePut(data);
  }

  /**
   * Create an upload URL for client-side uploads
   *
   * @param env - Cloudflare Workers environment bindings
   * @param data - Create upload request data (legacy format)
   * @returns Promise resolving to the create upload response
   */
  async createUpload(
    env: Bindings,
    data: SiloCreateUploadInput
  ): Promise<SiloCreateUploadResponse> {
    return env.SILO.createUpload(data);
  }

  /**
   * Batch get content by IDs
   *
   * @param env - Cloudflare Workers environment bindings
   * @param data - Batch get request data
   * @returns Promise resolving to a map of ID to item (legacy format)
   */
  async batchGet(
    env: Bindings,
    data: SiloBatchGetInput
  ): Promise<SiloBatchGetResponse> {
    return env.SILO.batchGet(data);
  }

  /**
   * Delete content by ID
   *
   * @param env - Cloudflare Workers environment bindings
   * @param data - Delete request data
   * @returns Promise resolving to the delete response
   */
  async delete(env: Bindings, data: SiloDeleteInput): Promise<SiloDeleteResponse> {
    return env.SILO.delete(data);
  }

  /**
   * Get storage statistics
   *
   * @param env - Cloudflare Workers environment bindings
   * @returns Promise resolving to the stats response
   */
  async stats(env: Bindings): Promise<SiloStatsResponse> {
    return env.SILO.stats({});
  }

  /**
   * Get content by ID and transform to a note
   *
   * @param env - Cloudflare Workers environment bindings
   * @param id - Content ID
   * @param userId - Optional user ID for access control
   * @returns Promise resolving to the note
   */
  async getContentAsNote(env: Bindings, id: string, userId?: string) {
    try {
      const response = await this.batchGet(env, {
        ids: [id],
        userId,
      });

      if (!response.items || response.items.length === 0) {
        this.logger.warn('Content not found', { id, userId });
        return null;
      }

      const item = response.items[0];
      return contentMapperService.mapBatchGetItemToNote(item);
    } catch (error) {
      this.logger.error('Failed to get content as note', {
        id,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });

      throw new ServiceError('Failed to get content as note', {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { id, userId },
      });
    }
  }

  /**
   * Get multiple contents by IDs and transform to notes
   *
   * @param env - Cloudflare Workers environment bindings
   * @param ids - Content IDs
   * @param userId - Optional user ID for access control
   * @returns Promise resolving to an array of notes
   */
  async getContentsAsNotes(env: Bindings, ids: string[], userId?: string) {
    try {
      if (ids.length === 0) {
        return [];
      }

      const response = await this.batchGet(env, {
        ids,
        userId,
      });

      if (!response.items || response.items.length === 0) {
        return [];
      }

      return response.items.map(item => contentMapperService.mapBatchGetItemToNote(item));
    } catch (error) {
      this.logger.error('Failed to get contents as notes', {
        ids,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });

      throw new ServiceError('Failed to get contents as notes', {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { ids, userId },
      });
    }
  }

}

/**
 * Singleton instance of the silo service
 */
export const siloService = new SiloService();
