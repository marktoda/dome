import { Bindings } from '../types';
import {
  SiloSimplePutInput,
  SiloBatchGetItem,
  SiloBatchGetInput,
  SiloDeleteInput,
  SiloSimplePutResponse,
  SiloBatchGetResponse,
  SiloDeleteResponse,
  SiloStatsResponse,
  ServiceError,
} from '@dome/common';
import { NotFoundError } from '../utils/errors';

export interface SiloGetInput extends Omit<SiloBatchGetInput, 'ids'> {
  id: string;
}

export type SiloGetResponse = SiloBatchGetItem;

/**
 * Service for interacting with the Silo content storage service
 * This service handles all content operations and is the single point of contact
 * with the Silo service for storing and retrieving content.
 */
export class SiloService {
  /**
   * Store content using the ingest queue
   *
   * @param env - Cloudflare Workers environment bindings
   * @param data - Content data to store
   * @returns Promise resolving to a simulated response with the content ID
   */
  async simplePut(env: Bindings, data: SiloSimplePutInput): Promise<SiloSimplePutResponse> {
    const id = data.id || crypto.randomUUID();
    const createdAt = Math.floor(Date.now() / 1000);

    // Create a message for the ingest queue
    const message: SiloSimplePutInput = {
      id,
      userId: data.userId,
      content: data.content,
      category: data.category || 'note',
      mimeType: data.mimeType || 'text/markdown',
      metadata: data.metadata,
    };

    // Send the message to the ingest queue
    await env.INGEST_QUEUE.send(message);

    // Return a simulated response with the content ID
    return {
      id,
      category: data.category || 'note',
      mimeType: data.mimeType || 'text/markdown',
      size:
        typeof data.content === 'string'
          ? new TextEncoder().encode(data.content).length
          : data.content.byteLength,
      createdAt,
    };
  }

  /**
   * Batch get content by IDs
   *
   * @param env - Cloudflare Workers environment bindings
   * @param data - Batch get request data
   * @returns Promise resolving to a map of ID to item (legacy format)
   */
  async batchGet(env: Bindings, data: SiloBatchGetInput): Promise<SiloBatchGetResponse> {
    try {
      console.log(
        'DOME-DEBUG: batchGet called with',
        JSON.stringify({
          ids: data.ids,
          userId: data.userId,
        }),
      );

      const response = await env.SILO.batchGet(data);

      console.log(
        'DOME-DEBUG: batchGet response',
        JSON.stringify({
          hasItems: !!response.items,
          itemsCount: response.items?.length || 0,
          firstItemId: response.items?.[0]?.id || null,
          total: response.total || 0,
        }),
      );

      return response;
    } catch (error) {
      console.log(
        'DOME-DEBUG: batchGet error',
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          errorType: error instanceof Error ? error.constructor.name : typeof error,
        }),
      );
      throw error;
    }
  }

  /**
   * get a single piece of content by id
   *
   * @param env - Cloudflare Workers environment bindings
   * @param data - get request data
   * @returns Promise resolving to a map of ID to item (legacy format)
   */
  async get(env: Bindings, data: SiloGetInput): Promise<SiloGetResponse> {
    const res = await this.batchGet(env, Object.assign({ ids: [data.id] }, data));
    if (res.items.length === 0) {
      throw new NotFoundError();
    }

    if (res.items.length !== 1) {
      throw new ServiceError('Unexpected number of items returned');
    }
    return res.items[0];
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
}

/**
 * Singleton instance of the silo service
 */
export const siloService = new SiloService();
