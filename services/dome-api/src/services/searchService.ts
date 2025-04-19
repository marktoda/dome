import { Bindings } from '../types';
import { Note } from '../models/note';
import { NoteRepository } from '../repositories/noteRepository';
import { vectorizeService, SearchResult } from './vectorizeService';
import { getLogger } from '@dome/logging';
import { ServiceError } from '@dome/common';
import { z } from 'zod';

/**
 * Search result interface with note content
 */
export interface NoteSearchResult {
  id: string;
  title: string;
  body: string;
  score: number;
  createdAt: number;
  updatedAt: number;
  contentType: string;
  metadata?: string;
}

/**
 * Paginated search results interface
 */
export interface PaginatedSearchResults {
  results: NoteSearchResult[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
  query: string;
}

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
  useCache?: boolean;
}

/**
 * Search options validation schema
 */
export const searchOptionsSchema = z.object({
  userId: z.string().min(1, 'User ID is required'),
  query: z.string().min(1, 'Query is required'),
  limit: z.number().int().positive().optional().default(10),
  offset: z.number().int().min(0).optional().default(0),
  contentType: z.string().optional(),
  startDate: z.number().int().optional(),
  endDate: z.number().int().optional(),
  useCache: z.boolean().optional().default(true),
});

/**
 * Service for searching notes using Constellation
 */
export class SearchService {
  private noteRepository: NoteRepository;
  private cache: Map<string, { timestamp: number; results: NoteSearchResult[] }>;
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache TTL

  /**
   * Constructor
   */
  constructor() {
    this.noteRepository = new NoteRepository();
    this.cache = new Map();
  }

  /**
   * Generate a cache key for search options
   * @param options Search options
   * @returns Cache key string
   */
  private generateCacheKey(options: SearchOptions): string {
    const { userId, query, contentType, startDate, endDate } = options;
    return `${userId}:${query}:${contentType || ''}:${startDate || ''}:${endDate || ''}`;
  }

  /**
   * Search notes using semantic search via Constellation
   * @param env Environment bindings
   * @param options Search options
   * @returns Promise<NoteSearchResult[]>
   */
  /**
   * Search notes using semantic search via Constellation
   * @param env Environment bindings
   * @param options Search options
   * @returns Promise<PaginatedSearchResults>
   */
  async searchNotes(env: Bindings, options: SearchOptions): Promise<PaginatedSearchResults> {
    try {
      // Validate options
      const validatedOptions = searchOptionsSchema.parse(options);
      const cacheKey = this.generateCacheKey(validatedOptions);

      // Check cache if enabled
      if (validatedOptions.useCache) {
        const cachedResult = this.cache.get(cacheKey);
        if (cachedResult && Date.now() - cachedResult.timestamp < this.CACHE_TTL_MS) {
          getLogger().info(
            { userId: validatedOptions.userId, query: validatedOptions.query },
            'Using cached search results'
          );

          // Apply pagination to cached results
          const paginatedResults = this.paginateResults(
            cachedResult.results,
            validatedOptions.offset || 0,
            validatedOptions.limit || 10
          );

          return paginatedResults;
        }
      }

      // Build filter for Constellation query
      const filter: Record<string, any> = {};

      // Add optional filters
      if (validatedOptions.startDate && validatedOptions.endDate) {
        filter.createdAt = {
          $gte: validatedOptions.startDate,
          $lte: validatedOptions.endDate,
        };
      } else if (validatedOptions.startDate) {
        filter.createdAt = {
          $gte: validatedOptions.startDate,
        };
      } else if (validatedOptions.endDate) {
        filter.createdAt = {
          $lte: validatedOptions.endDate,
        };
      }

      // Query Constellation via vectorizeService
      const searchResults = await vectorizeService.queryVectors(env, validatedOptions.query, {
        topK: validatedOptions.limit,
        filter,
      });

      // Get notes for the search results
      const noteIds = searchResults.map(result => result.metadata.noteId);
      const uniqueNoteIds = [...new Set(noteIds)];

      // Fetch notes from the database
      const notes: Note[] = [];
      for (const noteId of uniqueNoteIds) {
        try {
          getLogger().info({ noteId }, 'Fetching note from repository');
          const note = await this.noteRepository.findById(env, noteId);
          if (!note) {
            getLogger().warn({ noteId }, 'Note not found in repository');
            continue;
          } else {
            getLogger().info({ noteId }, 'Note found in repository');

            notes.push(note);
          }
        } catch (error) {
          getLogger().warn(
            { err: error, noteId },
            `Error fetching note ${noteId}`
          );
          // Continue with next note
        }
      }

      // Filter notes by content type if specified
      const filteredNotes = validatedOptions.contentType
        ? notes.filter(note => note.contentType === validatedOptions.contentType)
        : notes;

      // Map search results to note search results
      const noteSearchResults: NoteSearchResult[] = [];

      for (const result of searchResults) {
        const note = filteredNotes.find(n => n.id === result.metadata.noteId);
        if (note) {
          noteSearchResults.push({
            id: note.id,
            title: note.title,
            body: note.body,
            score: result.score,
            createdAt: note.createdAt,
            updatedAt: note.updatedAt,
            contentType: note.contentType,
            metadata: note.metadata,
          });
        }
      }

      // Sort by score (highest first)
      noteSearchResults.sort((a, b) => b.score - a.score);

      // Store in cache if caching is enabled
      if (validatedOptions.useCache) {
        this.cache.set(cacheKey, {
          timestamp: Date.now(),
          results: noteSearchResults,
        });
      }

      // Apply pagination
      return this.paginateResults(
        noteSearchResults,
        validatedOptions.offset || 0,
        validatedOptions.limit || 10,
        validatedOptions.query
      );
    } catch (error) {
      getLogger().error(
        { err: error, options },
        'Error searching notes'
      );
      throw new ServiceError('Failed to search notes', {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { options },
      });
    }
  }

  /**
   * Combined search for notes
   * @param env Environment bindings
   * @param options Search options
   * @returns Promise<NoteSearchResult[]>
   */
  /**
   * Paginate search results
   * @param results Full result set
   * @param offset Offset for pagination
   * @param limit Limit for pagination
   * @param query Original search query
   * @returns Paginated search results
   */
  private paginateResults(
    results: NoteSearchResult[],
    offset: number,
    limit: number,
    query: string = ''
  ): PaginatedSearchResults {
    const total = results.length;
    const paginatedResults = results.slice(offset, offset + limit);

    return {
      results: paginatedResults,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      },
      query,
    };
  }

  /**
   * Clear the search cache
   */
  clearCache(): void {
    this.cache.clear();
    getLogger().info('Search cache cleared');
  }

  /**
   * Combined search for notes
   * @param env Environment bindings
   * @param options Search options
   * @returns Promise<PaginatedSearchResults>
   */
  async search(env: Bindings, options: SearchOptions): Promise<PaginatedSearchResults> {
    // With Constellation, we can just use the searchNotes method
    return this.searchNotes(env, options);
  }
}

// Export singleton instance
export const searchService = new SearchService();
