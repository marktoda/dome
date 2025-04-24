import { Bindings } from '../types';
import { ServiceError, VectorMeta } from '@dome/common';
import { getLogger } from '@dome/logging';
import { ConstellationClient } from '@dome/constellation/client';
import { SiloClient } from '@dome/silo/client';

/**
 * Search options interface
 */
export interface SearchOptions {
  userId: string;
  query: string;
  limit?: number;
  offset?: number;
  category?: string;
  mimeType?: string;
  startDate?: number;
  endDate?: number;
}

/**
 * Search result interface
 */
export interface SearchResult {
  id: string;
  title: string;
  summary: string;
  body: string;
  category: string;
  mimeType: string;
  createdAt: number;
  updatedAt: number;
  score: number;
}

/**
 * Paginated search results interface
 */
export interface PaginatedSearchResults {
  results: SearchResult[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
  query: string;
}

const DEFAULT_TOP_K = 10;

/**
 * Service for searching content using semantic search
 * This service handles:
 * - Semantic search via Constellation
 * - Content retrieval via Silo
 * - Result transformation and pagination
 */
export class SearchService {
  private logger;
  private cache: Map<string, PaginatedSearchResults>;
  private cacheTTL: number = 5 * 60 * 1000; // 5 minutes
  private cacheTimestamps: Map<string, number>;
  private constellation: ConstellationClient;
  private silo: SiloClient;

  constructor(constellationClient: ConstellationClient, siloClient: SiloClient) {
    this.logger = getLogger();
    this.cache = new Map();
    this.cacheTimestamps = new Map();
    this.constellation = constellationClient;
    this.silo = siloClient;
  }

  /**
   * Search for content using semantic search
   *
   * @param env - Cloudflare Workers environment bindings
   * @param options - Search options
   * @returns Promise resolving to paginated search results
   */
  async searchContent(env: Bindings, options: SearchOptions): Promise<PaginatedSearchResults> {
    try {
      const {
        userId,
        query,
        limit = 10,
        offset = 0,
        category,
        mimeType,
        startDate,
        endDate,
      } = options;

      this.logger.debug('Searching content', {
        userId,
        query,
        limit,
        offset,
        category,
        mimeType,
        startDate,
        endDate,
      });

      // Generate cache key
      const cacheKey = this.generateCacheKey(options);

      // Check cache
      const cachedResults = this.getFromCache(cacheKey);
      if (cachedResults) {
        this.logger.debug('Returning cached search results', {
          userId,
          query,
          resultCount: cachedResults.results.length,
        });
        return cachedResults;
      }

      // Perform semantic search using Constellation
      const filter: Partial<VectorMeta> = { userId };
      const searchResults = await this.constellation.query(query, filter);

      if (searchResults.length === 0) {
        const emptyResults: PaginatedSearchResults = {
          results: [],
          pagination: {
            total: 0,
            limit,
            offset,
            hasMore: false,
          },
          query,
        };

        this.addToCache(cacheKey, emptyResults);
        return emptyResults;
      }

      const contentIds = [...new Set(searchResults.map(result => result.metadata.contentId))];

      this.logger.info(
        {
          contentIdsCount: contentIds.length,
          firstFewContentIds: contentIds.slice(0, 5),
          userId,
        },
        'Unique content IDs extracted',
      );

      const contents = await this.silo.batchGet({ ids: contentIds, userId });
      this.logger.info(
        {
          contentsCount: contents.items.length,
          firstContentId: contents.items.length > 0 ? contents.items[0].id : null,
        },
        'Results from siloService.batchGet',
      );

      // Map content IDs to scores
      const scoreMap = new Map<string, number>();
      for (const result of searchResults) {
        scoreMap.set(result.id, result.score);
      }
      this.logger.info({ scoreMapLength: scoreMap.size, scores: JSON.stringify(scoreMap) }, 'Created score map');

      // Filter and transform results
      let filteredResults = contents.items
        .filter((note: any) => {
          // Skip notes with missing required fields
          if (!note.id || !note.category) {
            getLogger().warn({ note }, 'Skipping note with missing id / category');
            return false;
          }

          // Apply category filter if specified
          if (category && note.category !== category) {
            getLogger().info({ note }, 'Skipping note with incorrect category');
            return false;
          }

          // Apply MIME type filter if specified
          if (mimeType && note.mimeType !== mimeType) {
            getLogger().info({ note }, 'Skipping note with incorrect mime type');
            return false;
          }

          // Apply date range filter if specified
          const createdAt = note.createdAt || 0;
          if (startDate && createdAt < startDate) {
            getLogger().info({ note }, 'Skipping note outside date range');
            return false;
          }

          if (endDate && createdAt > endDate) {
            getLogger().info({ note }, 'Skipping note outside date range');
            return false;
          }

          return true;
        })
        .map((note: any) => {
          const createdAt = note.createdAt || Date.now();

          return {
            id: note.id,
            title: note.title || '',
            summary: note.summary || '',
            body: note.body || '',
            category: note.category,
            mimeType: note.mimeType || 'text/plain',
            createdAt: createdAt,
            score: scoreMap.get(note.id) || 0,
          } as SearchResult;
        })
        .sort((a: SearchResult, b: SearchResult) => b.score - a.score);

      // Apply pagination
      const total = filteredResults.length;
      filteredResults = filteredResults.slice(offset, offset + limit);

      const results: PaginatedSearchResults = {
        results: filteredResults,
        pagination: {
          total,
          limit,
          offset,
          hasMore: offset + limit < total,
        },
        query,
      };

      // Cache results
      this.addToCache(cacheKey, results);

      this.logger.debug('Search completed successfully', {
        userId,
        query,
        resultCount: filteredResults.length,
        total,
      });

      return results;
    } catch (error) {
      this.logger.error('Search failed', {
        options,
        error: error instanceof Error ? error.message : String(error),
      });

      throw new ServiceError('Failed to search content', {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { options },
      });
    }
  }

  /**
   * Search for content
   *
   * @param env - Cloudflare Workers environment bindings
   * @param options - Search options
   * @returns Promise resolving to paginated search results
   */
  async search(env: Bindings, options: SearchOptions): Promise<PaginatedSearchResults> {
    return this.searchContent(env, options);
  }

  /**
   * Search for notes (alias for searchContent for backward compatibility)
   *
   * @param env - Cloudflare Workers environment bindings
   * @param options - Search options
   * @returns Promise resolving to paginated search results
   * @deprecated Use searchContent instead
   */
  async searchNotes(env: Bindings, options: SearchOptions): Promise<PaginatedSearchResults> {
    return this.searchContent(env, options);
  }

  /**
   * Generate a cache key from search options
   *
   * @param options - Search options
   * @returns Cache key string
   */
  private generateCacheKey(options: SearchOptions): string {
    const {
      userId,
      query,
      limit = 10,
      offset = 0,
      category,
      mimeType,
      startDate,
      endDate,
    } = options;
    return `${userId}:${query}:${limit}:${offset}:${category || ''}:${mimeType || ''}:${startDate || ''
      }:${endDate || ''}`;
  }

  /**
   * Get results from cache if available and not expired
   *
   * @param key - Cache key
   * @returns Cached results or undefined if not found or expired
   */
  private getFromCache(key: string): PaginatedSearchResults | undefined {
    const timestamp = this.cacheTimestamps.get(key);
    if (!timestamp) {
      return undefined;
    }

    const now = Date.now();
    if (now - timestamp > this.cacheTTL) {
      // Cache expired, remove it
      this.cache.delete(key);
      this.cacheTimestamps.delete(key);
      return undefined;
    }

    return this.cache.get(key);
  }

  /**
   * Add results to cache
   *
   * @param key - Cache key
   * @param results - Results to cache
   */
  private addToCache(key: string, results: PaginatedSearchResults): void {
    this.cache.set(key, results);
    this.cacheTimestamps.set(key, Date.now());

    // Prune cache if it gets too large
    if (this.cache.size > 100) {
      this.pruneCache();
    }
  }

  /**
   * Prune the oldest entries from the cache
   */
  private pruneCache(): void {
    // Sort timestamps by age (oldest first)
    const sortedEntries = [...this.cacheTimestamps.entries()].sort((a, b) => a[1] - b[1]);

    // Remove the oldest 20% of entries
    const entriesToRemove = Math.ceil(sortedEntries.length * 0.2);
    for (let i = 0; i < entriesToRemove; i++) {
      const [key] = sortedEntries[i];
      this.cache.delete(key);
      this.cacheTimestamps.delete(key);
    }
  }
}

// No longer exporting a singleton instance
// The service factory will create and manage instances
