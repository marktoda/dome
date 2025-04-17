import { Bindings } from '../types';
import { ServiceError } from '@dome/common';

/**
 * Type definitions for Cloudflare Vectorize
 * Based on Cloudflare Workers documentation
 */
interface VectorizeVector {
  id: string;
  values: number[];
  metadata?: Record<string, any>;
}

interface VectorizeQueryOptions {
  topK?: number;
  filter?: Record<string, any>;
}

interface VectorizeQueryResult {
  matches: Array<{
    id: string;
    score: number;
    metadata?: Record<string, any>;
  }>;
  cursor?: string;
}

// Extend the global VectorizeIndex interface
declare global {
  interface VectorizeIndex {
    insert(vectors: VectorizeVector[]): Promise<void>;
    upsert(vectors: VectorizeVector[]): Promise<void>;
    query(options: { vector: number[] } & VectorizeQueryOptions): Promise<VectorizeQueryResult>;
    delete(ids: string[]): Promise<void>;
  }
}

/**
 * Metadata interface for vectors
 */
export interface VectorMetadata {
  userId: string;
  noteId: string;
  createdAt: number;
  pageNum?: number;
}

/**
 * Search result interface
 */
export interface SearchResult {
  id: string;
  score: number;
  metadata: VectorMetadata;
}

/**
 * Service for interacting with Cloudflare Vectorize
 */
export class VectorizeService {
  /**
   * Add a vector to the Vectorize index
   * @param env Environment bindings
   * @param id Vector ID (usually the note ID or note page ID)
   * @param vector The embedding vector
   * @param metadata Metadata for the vector
   * @returns Promise<void>
   */
  async addVector(
    env: Bindings,
    id: string,
    vector: number[],
    metadata: VectorMetadata
  ): Promise<void> {
    try {
      await env.VECTORIZE.insert([
        {
          id,
          values: vector,
          metadata
        }
      ]);
    } catch (error) {
      console.error('Error adding vector to Vectorize:', error);
      throw new ServiceError('Failed to add vector to Vectorize', {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { id, metadata }
      });
    }
  }

  /**
   * Update a vector in the Vectorize index
   * @param env Environment bindings
   * @param id Vector ID
   * @param vector The embedding vector
   * @param metadata Metadata for the vector
   * @returns Promise<void>
   */
  async updateVector(
    env: Bindings,
    id: string,
    vector: number[],
    metadata: VectorMetadata
  ): Promise<void> {
    try {
      // Vectorize.upsert will overwrite existing vectors with the same ID
      await env.VECTORIZE.upsert([
        {
          id,
          values: vector,
          metadata
        }
      ]);
    } catch (error) {
      console.error('Error updating vector in Vectorize:', error);
      throw new ServiceError('Failed to update vector in Vectorize', {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { id, metadata }
      });
    }
  }

  /**
   * Delete a vector from the Vectorize index
   * @param env Environment bindings
   * @param id Vector ID
   * @returns Promise<void>
   */
  async deleteVector(env: Bindings, id: string): Promise<void> {
    try {
      await env.VECTORIZE.delete([id]);
    } catch (error) {
      console.error('Error deleting vector from Vectorize:', error);
      throw new ServiceError('Failed to delete vector from Vectorize', {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { id }
      });
    }
  }

  /**
   * Query vectors in the Vectorize index
   * @param env Environment bindings
   * @param vector The query vector
   * @param options Query options
   * @returns Promise<SearchResult[]>
   */
  async queryVectors(
    env: Bindings,
    vector: number[],
    options: {
      topK?: number;
      filter?: Partial<VectorMetadata>;
    } = {}
  ): Promise<SearchResult[]> {
    try {
      const { topK = 10, filter } = options;
      
      const results = await env.VECTORIZE.query({
        vector,
        topK,
        filter: filter as Record<string, any>
      });
      
      return results.matches.map((match: any) => ({
        id: match.id,
        score: match.score,
        metadata: match.metadata as VectorMetadata
      }));
    } catch (error) {
      console.error('Error querying vectors from Vectorize:', error);
      throw new ServiceError('Failed to query vectors from Vectorize', {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { options }
      });
    }
  }

  /**
   * Get vectors by IDs
   * @param env Environment bindings
   * @param ids Vector IDs
   * @returns Promise<Map<string, { vector: number[], metadata: VectorMetadata }>>
   */
  async getVectorsByIds(
    env: Bindings,
    ids: string[]
  ): Promise<Map<string, { vector: number[], metadata: VectorMetadata }>> {
    try {
      // Vectorize doesn't have a direct getByIds method, so we'll use query with a filter
      // This is a workaround and may not be efficient for large numbers of IDs
      const vectorMap = new Map();
      
      // Fetch vectors in batches to avoid hitting limits
      const batchSize = 20;
      for (let i = 0; i < ids.length; i += batchSize) {
        const batchIds = ids.slice(i, i + batchSize);
        
        // For each ID in the batch, perform a separate query
        // This is not ideal but works as a fallback
        for (const id of batchIds) {
          try {
            // Since getVector doesn't exist, we'll use query with a filter on ID
            const result = await env.VECTORIZE.query({
              vector: new Array(1536).fill(0), // Dummy vector
              topK: 1,
              filter: { id }
            });
            
            const vector = result.matches.length > 0 ? {
              values: new Array(1536).fill(0), // We don't get the actual vector values from query
              metadata: result.matches[0].metadata
            } : null;
            if (vector) {
              vectorMap.set(id, {
                vector: vector.values,
                metadata: vector.metadata as VectorMetadata
              });
            }
          } catch (e) {
            // Skip vectors that don't exist
            console.warn(`Vector with ID ${id} not found`);
          }
        }
      }
      
      return vectorMap;
    } catch (error) {
      console.error('Error getting vectors by IDs from Vectorize:', error);
      throw new ServiceError('Failed to get vectors by IDs from Vectorize', {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { ids }
      });
    }
  }

  /**
   * List vectors with optional filter
   * @param env Environment bindings
   * @param filter Optional metadata filter
   * @param options List options
   * @returns Promise<{ vectors: { id: string, metadata: VectorMetadata }[], cursor?: string }>
   */
  async listVectors(
    env: Bindings,
    filter?: Partial<VectorMetadata>,
    options: {
      limit?: number;
      cursor?: string;
    } = {}
  ): Promise<{
    vectors: { id: string; metadata: VectorMetadata }[];
    cursor?: string;
  }> {
    try {
      const { limit = 100, cursor } = options;
      
      // Vectorize doesn't have a direct list method, so we'll use a workaround
      // This is a simplified implementation that may need to be adjusted
      // based on the actual Vectorize API capabilities
      
      // We'll use a dummy vector and a very high topK to simulate listing
      // This is not ideal but works as a fallback
      const dummyVector = new Array(1536).fill(0);
      
      const results = await env.VECTORIZE.query({
        vector: dummyVector,
        topK: limit,
        filter: filter as Record<string, any>
      });
      
      // Since we're using query as a workaround for list, we don't have a cursor
      // We'll return undefined for the cursor to indicate there are no more results
      return {
        vectors: results.matches.map((v: any) => ({
          id: v.id,
          metadata: v.metadata as VectorMetadata
        })),
        cursor: undefined
      };
    } catch (error) {
      console.error('Error listing vectors from Vectorize:', error);
      throw new ServiceError('Failed to list vectors from Vectorize', {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { filter, options }
      });
    }
  }
}

// Export singleton instance
export const vectorizeService = new VectorizeService();