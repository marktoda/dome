import { Bindings, ConstellationService as ConstellationBinding } from '../types';
import {
  ServiceError,
  SiloEmbedJob,
  VectorMeta,
  VectorSearchResult,
  VectorIndexStats,
} from '@dome/common';
import { getLogger } from '@dome/logging';

/**
 * Configuration constants for text processing
 */
const MAX_TEXT_LENGTH = 8192;
const MIN_TEXT_LENGTH = 3;
const DEFAULT_TOP_K = 10;

/**
 * Service for interacting with the Constellation service
 * This service is the single point of contact with Constellation and handles:
 * - Type conversion between domain types and Constellation types
 * - Consistent error handling and logging
 * - Text preprocessing
 */
export class ConstellationService {
  private logger = getLogger();

  /**
   * Query for similar embeddings using the Constellation service
   *
   * @param env - Cloudflare Workers environment bindings
   * @param text - Query text
   * @param filter - Optional metadata filter
   * @param topK - Optional number of results to return
   * @returns Promise resolving to search results
   */
  async query(
    env: Bindings,
    text: string,
    filter?: Partial<VectorMeta>,
    topK: number = DEFAULT_TOP_K,
  ): Promise<VectorSearchResult[]> {
    try {
      this.validateConstellationBinding(env.CONSTELLATION);

      const processedText = this.preprocess(text);
      this.logger.debug('Querying embeddings', {
        textLength: text.length,
        filter,
        topK,
      });

      const results = await env.CONSTELLATION!.query(processedText, filter, topK);

      this.logger.debug('Successfully queried embeddings', {
        resultCount: results.length,
      });

      return results;
    } catch (error) {
      this.logger.error('Failed to query embeddings', {
        textLength: text.length,
        filter,
        topK,
        error: error instanceof Error ? error.message : String(error),
      });

      throw new ServiceError('Failed to query embeddings', {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { textLength: text.length, filter, topK },
      });
    }
  }

  /**
   * Get vector index statistics
   *
   * @param env - Cloudflare Workers environment bindings
   * @returns Promise resolving to vector index statistics
   */
  async getStats(env: Bindings): Promise<VectorIndexStats> {
    try {
      this.validateConstellationBinding(env.CONSTELLATION);

      this.logger.debug('Getting vector index statistics');

      const stats = await env.CONSTELLATION!.stats();

      this.logger.debug('Successfully got vector index statistics', {
        vectors: stats.vectors,
      });

      return stats;
    } catch (error) {
      this.logger.error('Failed to get vector index statistics', {
        error: error instanceof Error ? error.message : String(error),
      });

      throw new ServiceError('Failed to get vector index statistics', {
        cause: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  /**
   * Search for similar notes using semantic search
   *
   * @param env - Cloudflare Workers environment bindings
   * @param query - Search query text
   * @param userId - User ID to filter results by
   * @param topK - Number of results to return
   * @returns Promise resolving to search results with note IDs and scores
   */
  async searchNotes(
    env: Bindings,
    query: string,
    userId: string,
    topK: number = DEFAULT_TOP_K,
  ): Promise<Array<{ contentId: string; score: number }>> {
    try {
      const filter: Partial<VectorMeta> = { userId };

      const results = await this.query(env, query, filter, topK);

      // Inline the mapVectorResultsToContentIds logic
      // Add detailed logging to understand the metadata structure
      if (results.length > 0) {
        const firstResult = results[0];
        this.logger.debug('First search result metadata:', {
          metadata: firstResult.metadata,
          hasContentId: 'contentId' in firstResult.metadata,
          metadataKeys: Object.keys(firstResult.metadata)
        });
      }
      
      return results.map(result => {
        // Check if metadata exists
        if (!result.metadata) {
          this.logger.warn('Missing metadata in search result:', { id: result.id });
          return { contentId: '', score: result.score };
        }
        
        // Extract contentId with more robust checks
        let contentId = '';
        const metadata = result.metadata as any;
        
        if (metadata.hasOwnProperty('contentId') && metadata.contentId) {
          contentId = metadata.contentId;
        } else {
          // Try to extract contentId from the vector ID (format: content:contentId:chunkIndex)
          const idParts = result.id.split(':');
          if (idParts.length >= 2 && idParts[0] === 'content') {
            contentId = idParts[1];
          }
        }
        
        this.logger.debug(`Mapped result ${result.id} to contentId: ${contentId}`);
        
        return {
          contentId,
          score: result.score,
        };
      });
    } catch (error) {
      this.logger.error('Failed to search notes', {
        query,
        userId,
        topK,
        error: error instanceof Error ? error.message : String(error),
      });

      throw new ServiceError('Failed to search notes', {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { query, userId, topK },
      });
    }
  }

  /**
   * Preprocesses text for embedding generation
   *
   * @param text - The raw text to preprocess
   * @returns Processed text ready for embedding
   */
  private preprocess(text: string): string {
    // Normalize whitespace
    let processed = text.trim().replace(/\s+/g, ' ');

    // Handle very short inputs
    if (processed.length < MIN_TEXT_LENGTH) {
      processed = `${processed} ${processed} query search`;
    }

    // Truncate if too long
    if (processed.length > MAX_TEXT_LENGTH) {
      processed = processed.slice(0, MAX_TEXT_LENGTH);
    }

    return processed;
  }

  /**
   * Validates that the Constellation binding is available
   *
   * @param binding - The Constellation binding to validate
   * @throws ServiceError if the binding is not available
   */
  private validateConstellationBinding(binding?: ConstellationBinding): void {
    if (!binding) {
      throw new ServiceError('Constellation service is not available', {
        context: { message: 'CONSTELLATION binding is missing' },
      });
    }
  }
}

/**
 * Singleton instance of the constellation service
 */
export const constellationService = new ConstellationService();
