import { Bindings } from '../types';
import { ServiceError } from '@dome/common';
import { getLogger } from '@dome/logging';
import { constellationService } from './constellationService';
import { siloService } from './siloService';
import { contentMapperService } from './contentMapperService';

/**
 * Search options interface
 */
export interface SearchOptions {
  userId: string;
  query: string;
  limit?: number;
  offset?: number;
  contentType?: string;
  startDate?: number;
  endDate?: number;
}

/**
 * Search result interface
 */
export interface SearchResult {
  id: string;
  title: string;
  body: string;
  contentType: string;
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

/**
 * Service for searching notes using semantic search
 * This service handles:
 * - Semantic search via Constellation
 * - Content retrieval via Silo
 * - Result transformation and pagination
 */
export class SearchService {
  private logger = getLogger();
  private cache: Map<string, PaginatedSearchResults>;
  private cacheTTL: number = 5 * 60 * 1000; // 5 minutes
  private cacheTimestamps: Map<string, number>;

  constructor() {
    this.cache = new Map();
    this.cacheTimestamps = new Map();
  }

  /**
   * Search for notes using semantic search
   *
   * @param env - Cloudflare Workers environment bindings
   * @param options - Search options
   * @returns Promise resolving to paginated search results
   */
  async searchNotes(env: Bindings, options: SearchOptions): Promise<PaginatedSearchResults> {
    try {
      const { userId, query, limit = 10, offset = 0, contentType, startDate, endDate } = options;

      this.logger.debug('Searching notes', {
        userId,
        query,
        limit,
        offset,
        contentType,
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
      const searchResults = await constellationService.searchNotes(
        env,
        query,
        userId,
        limit * 2, // Fetch more results to account for filtering
      );

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

      // Get unique note IDs
      const noteIds = [...new Set(searchResults.map(result => result.noteId))];

      // Retrieve note content from Silo
      const notes = await siloService.getContentsAsNotes(env, noteIds, userId);

      // Map note IDs to scores
      const scoreMap = new Map<string, number>();
      for (const result of searchResults) {
        scoreMap.set(result.noteId, result.score);
      }

      // Filter and transform results
      let filteredResults = notes
        .filter(note => {
          // Skip notes with missing required fields
          if (!note.id || !note.contentType) {
            return false;
          }

          // Apply content type filter if specified
          if (contentType && note.contentType !== contentType) {
            return false;
          }

          // Apply date range filter if specified
          const createdAt = note.createdAt || 0;
          if (startDate && createdAt < startDate) {
            return false;
          }

          if (endDate && createdAt > endDate) {
            return false;
          }

          return true;
        })
        .map(note => {
          // Ensure all required fields are present
          if (!note.id || !note.contentType) {
            throw new Error('Note is missing required fields');
          }

          const createdAt = note.createdAt || Date.now();
          const updatedAt = note.updatedAt || createdAt;

          return {
            id: note.id,
            title: note.title || '',
            body: note.body || '',
            contentType: note.contentType,
            createdAt: createdAt,
            updatedAt: updatedAt,
            score: scoreMap.get(note.id) || 0,
          } as SearchResult;
        })
        .sort((a, b) => b.score - a.score);

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

      throw new ServiceError('Failed to search notes', {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { options },
      });
    }
  }

  /**
   * Search for notes (alias for searchNotes)
   *
   * @param env - Cloudflare Workers environment bindings
   * @param options - Search options
   * @returns Promise resolving to paginated search results
   */
  async search(env: Bindings, options: SearchOptions): Promise<PaginatedSearchResults> {
    return this.searchNotes(env, options);
  }

  /**
   * Generate a cache key from search options
   *
   * @param options - Search options
   * @returns Cache key string
   */
  private generateCacheKey(options: SearchOptions): string {
    const { userId, query, limit = 10, offset = 0, contentType, startDate, endDate } = options;
    return `${userId}:${query}:${limit}:${offset}:${contentType || ''}:${startDate || ''}:${
      endDate || ''
    }`;
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

/**
 * Singleton instance of the search service
 */
export const searchService = new SearchService();
