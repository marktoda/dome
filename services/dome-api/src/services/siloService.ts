import { Bindings } from '../types';
import { ServiceError } from '@dome/common';
import { getLogger } from '@dome/logging';
import {
  SiloContentMetadata,
  SiloSimplePutRequest,
  SiloSimplePutResponse,
  SiloCreateUploadRequest,
  SiloCreateUploadResponse,
  SiloBatchGetRequest,
  SiloBatchGetResponse,
  SiloBatchGetItem,
  SiloDeleteRequest,
  SiloDeleteResponse,
  SiloStatsResponse,
} from '../types/siloTypes';
import { contentMapperService } from './contentMapperService';

/**
 * Service for interacting with the Silo content storage service
 * This service handles all content operations and is the single point of contact
 * with the Silo service for storing and retrieving content.
 */
export class SiloService {
  private logger = getLogger();

  /**
   * Call a Silo RPC method with proper error handling
   *
   * @param env - Cloudflare Workers environment bindings
   * @param method - RPC method name
   * @param data - Request data
   * @returns Promise resolving to the response
   */
  private async callRPC<T>(env: Bindings, method: string, data: any): Promise<T> {
    try {
      this.logger.debug('Calling Silo RPC', {
        method,
        data: { ...data, content: data.content ? '[CONTENT]' : undefined },
      });

      const headers = new Headers({ 'Content-Type': 'application/json' });
      if (data.userId) {
        headers.set('x-user-id', data.userId);
      }

      const response = await (env.SILO as any).fetch(
        new Request(`http://silo/rpc/${method}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(data),
        }),
      );

      if (!response.ok) {
        let errorBody: any;
        try {
          errorBody = await response.json();
        } catch {
          errorBody = await response.text();
        }

        this.logger.error('Silo RPC failed', {
          method,
          status: response.status,
          error: errorBody,
        });

        throw new ServiceError(`Silo RPC ${method} failed`, {
          context: { status: response.status, error: errorBody },
        });
      }

      const result = (await response.json()) as T;
      this.logger.debug('Silo RPC succeeded', { method, result });
      return result;
    } catch (error) {
      this.logger.error('Error calling Silo RPC', {
        method,
        error: error instanceof Error ? error.message : String(error),
      });

      throw new ServiceError(`Error calling Silo RPC method ${method}`, {
        cause: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  /**
   * Store content directly using the simple put API
   *
   * @param env - Cloudflare Workers environment bindings
   * @param data - Simple put request data (legacy format)
   * @returns Promise resolving to the simple put response
   */
  async simplePut(
    env: Bindings,
    data: { body: any; contentType?: string; id?: string; userId?: string },
  ): Promise<{ id: string; contentType: string; size: number; createdAt: number }> {
    // Convert from legacy format to new type
    const request: SiloSimplePutRequest = {
      id: data.id,
      userId: data.userId,
      content: data.body,
      contentType: data.contentType || 'text/plain',
    };

    return this.callRPC<SiloSimplePutResponse>(env, 'simplePut', request);
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
    data: { size: number; contentType?: string; sha256?: string; userId?: string },
  ): Promise<{
    id: string;
    uploadUrl: string;
    formData: Record<string, string>;
    expiresIn: number;
  }> {
    // Convert from legacy format to new type
    const request: SiloCreateUploadRequest = {
      contentType: data.contentType || 'application/octet-stream',
      size: data.size,
      metadata: {},
      userId: data.userId,
      sha256: data.sha256,
    };

    return this.callRPC<SiloCreateUploadResponse>(env, 'createUpload', request);
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
    data: { ids: string[]; userId?: string },
  ): Promise<Record<string, any>> {
    // Convert from legacy format to new type
    const request: SiloBatchGetRequest = {
      ids: data.ids,
      userId: data.userId,
    };

    const response = await this.callRPC<SiloBatchGetResponse>(env, 'batchGet', request);

    // Convert from new type to legacy format
    const resultMap: Record<string, any> = {};
    if (response.items) {
      for (const item of response.items) {
        resultMap[item.id] = item;
      }
    }

    return resultMap;
  }

  /**
   * Delete content by ID
   *
   * @param env - Cloudflare Workers environment bindings
   * @param data - Delete request data
   * @returns Promise resolving to the delete response
   */
  async delete(env: Bindings, data: { id: string; userId?: string }): Promise<SiloDeleteResponse> {
    const request: SiloDeleteRequest = {
      id: data.id,
      userId: data.userId,
    };

    return this.callRPC<SiloDeleteResponse>(env, 'delete', request);
  }

  /**
   * Get storage statistics
   *
   * @param env - Cloudflare Workers environment bindings
   * @returns Promise resolving to the stats response
   */
  async stats(env: Bindings): Promise<SiloStatsResponse> {
    return this.callRPC<SiloStatsResponse>(env, 'stats', {});
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
      const response = await this.callRPC<SiloBatchGetResponse>(env, 'batchGet', {
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

      const response = await this.callRPC<SiloBatchGetResponse>(env, 'batchGet', {
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

  /**
   * Get content by ID and transform to a task
   *
   * @param env - Cloudflare Workers environment bindings
   * @param id - Content ID
   * @param userId - Optional user ID for access control
   * @returns Promise resolving to the task
   */
  async getContentAsTask(env: Bindings, id: string, userId?: string) {
    try {
      const response = await this.callRPC<SiloBatchGetResponse>(env, 'batchGet', {
        ids: [id],
        userId,
      });

      if (!response.items || response.items.length === 0) {
        this.logger.warn('Content not found', { id, userId });
        return null;
      }

      const item = response.items[0];
      return contentMapperService.mapBatchGetItemToTask(item);
    } catch (error) {
      this.logger.error('Failed to get content as task', {
        id,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });

      throw new ServiceError('Failed to get content as task', {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { id, userId },
      });
    }
  }
}

/**
 * Singleton instance of the silo service
 */
export const siloService = new SiloService();
