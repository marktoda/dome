import { Bindings } from '../types';
import { getLogger } from '@dome/logging';
import { ServiceError, NoteVectorMeta } from '@dome/common';

/* -------------------------------------------------------------------------- */
/*                                  TYPES                                     */
/* -------------------------------------------------------------------------- */

export interface VectorMetadata {
  userId: string;
  noteId: string;
  createdAt: number;
  pageNum?: number;
}

export interface SearchResult {
  id: string;
  score: number;
  metadata: VectorMetadata;
}

/* -------------------------------------------------------------------------- */
/*                              ERROR HELPER                                  */
/* -------------------------------------------------------------------------- */

const err = (msg: string, ctx: Record<string, unknown>, cause: unknown) =>
  new ServiceError(msg, {
    cause: cause instanceof Error ? cause : new Error(String(cause)),
    context: ctx,
  });

/* -------------------------------------------------------------------------- */
/*                                SERVICE                                      */
/* -------------------------------------------------------------------------- */

export class VectorizeService {
  /**
   * Query vectors using Constellation
   *
   * @param env - Cloudflare Workers environment bindings
   * @param queryText - Text to search for
   * @param options - Search options
   * @returns Promise resolving to search results
   */
  async queryVectors(
    env: Bindings,
    queryText: string,
    options: { topK?: number; filter?: Partial<VectorMetadata> } = {},
  ): Promise<SearchResult[]> {
    const { topK = 10, filter } = options;

    try {
      // Convert VectorMetadata to NoteVectorMeta
      const noteVectorFilter: Partial<NoteVectorMeta> = {};
      if (filter?.userId) noteVectorFilter.userId = filter.userId;
      if (filter?.noteId) noteVectorFilter.noteId = filter.noteId;
      if (filter?.createdAt) noteVectorFilter.createdAt = filter.createdAt;

      // Query Constellation
      const results = await env.CONSTELLATION!.query(queryText, noteVectorFilter, topK);

      // Convert VectorSearchResult to SearchResult
      return results.map(result => ({
        id: result.id,
        score: result.score,
        metadata: {
          userId: result.metadata.userId,
          noteId: result.metadata.noteId,
          createdAt: result.metadata.createdAt,
          // pageNum is not supported in Constellation yet
        } as VectorMetadata,
      }));
    } catch (error) {
      throw err('queryVectors failed', { options }, error);
    }
  }

  /**
   * Get vector index statistics
   *
   * @param env - Cloudflare Workers environment bindings
   * @returns Promise resolving to vector index statistics
   */
  async getStats(env: Bindings) {
    try {
      return await env.CONSTELLATION!.stats();
    } catch (error) {
      throw err('getStats failed', {}, error);
    }
  }

  /* shorter aliases */
  query = this.queryVectors.bind(this);
}

export const vectorizeService = new VectorizeService();
