import { Bindings } from '../types';
import { Note } from '../models/note';
import { NoteRepository } from '../repositories/noteRepository';
import { vectorizeService, SearchResult } from './vectorizeService';
import { embeddingService } from './embeddingService';
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
 * Search options interface
 */
export interface SearchOptions {
  userId: string;
  query: string;
  limit?: number;
  contentType?: string;
  startDate?: number;
  endDate?: number;
}

/**
 * Search options validation schema
 */
export const searchOptionsSchema = z.object({
  userId: z.string().min(1, 'User ID is required'),
  query: z.string().min(1, 'Query is required'),
  limit: z.number().int().positive().optional().default(10),
  contentType: z.string().optional(),
  startDate: z.number().int().optional(),
  endDate: z.number().int().optional(),
});

/**
 * Service for searching notes
 */
export class SearchService {
  private noteRepository: NoteRepository;

  /**
   * Constructor
   */
  constructor() {
    this.noteRepository = new NoteRepository();
  }

  /**
   * Search notes using semantic search
   * @param env Environment bindings
   * @param options Search options
   * @returns Promise<NoteSearchResult[]>
   */
  async searchNotes(env: Bindings, options: SearchOptions): Promise<NoteSearchResult[]> {
    try {
      // Validate options
      const validatedOptions = searchOptionsSchema.parse(options);

      // Generate embedding for the query
      const embedding = await embeddingService.generateEmbedding(env, validatedOptions.query);

      // Build filter for Vectorize query
      const filter: Record<string, any> = {
        userId: validatedOptions.userId,
      };

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

      // Query Vectorize
      const searchResults = await vectorizeService.queryVectors(env, embedding, {
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
          const note = await this.noteRepository.findById(env, noteId);
          if (note) {
            notes.push(note);
          }
        } catch (error) {
          console.warn(`Error fetching note ${noteId}:`, error);
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

      // Limit results
      return noteSearchResults.slice(0, validatedOptions.limit);
    } catch (error) {
      console.error('Error searching notes:', error);
      throw new ServiceError('Failed to search notes', {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { options },
      });
    }
  }

  /**
   * Search note pages
   * @param env Environment bindings
   * @param options Search options
   * @returns Promise<NoteSearchResult[]>
   */
  async searchNotePages(env: Bindings, options: SearchOptions): Promise<NoteSearchResult[]> {
    try {
      // Validate options
      const validatedOptions = searchOptionsSchema.parse(options);

      // Generate embedding for the query
      const embedding = await embeddingService.generateEmbedding(env, validatedOptions.query);

      // Build filter for Vectorize query
      const filter: Record<string, any> = {
        userId: validatedOptions.userId,
      };

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

      // Query Vectorize
      const searchResults = await vectorizeService.queryVectors(env, embedding, {
        topK: validatedOptions.limit,
        filter,
      });

      // Get notes and pages for the search results
      const noteIds = [...new Set(searchResults.map(result => result.metadata.noteId))];
      const pageIds = searchResults.map(result => result.id);

      // Fetch notes from the database
      const notes: Record<string, Note> = {};
      for (const noteId of noteIds) {
        try {
          const note = await this.noteRepository.findById(env, noteId);
          if (note) {
            notes[noteId] = note;
          }
        } catch (error) {
          console.warn(`Error fetching note ${noteId}:`, error);
          // Continue with next note
        }
      }

      // Fetch pages from the database
      const pages: Record<string, string> = {};
      for (const pageId of pageIds) {
        try {
          const db = await env.D1_DATABASE;
          const result = await db
            .prepare(
              `
            SELECT content FROM note_pages WHERE id = ?
          `,
            )
            .bind(pageId)
            .first();

          const typedResult = result as { content: string } | null;

          if (typedResult) {
            pages[pageId] = typedResult.content;
          }
        } catch (error) {
          console.warn(`Error fetching page ${pageId}:`, error);
          // Continue with next note
        }
      }

      // Filter notes by content type if specified
      const filteredResults = validatedOptions.contentType
        ? searchResults.filter(result => {
          const note = notes[result.metadata.noteId];
          return note && note.contentType === validatedOptions.contentType;
        })
        : searchResults;

      // Map search results to note search results
      const noteSearchResults: NoteSearchResult[] = [];

      for (const result of filteredResults) {
        const note = notes[result.metadata.noteId];
        const pageContent = pages[result.id];

        if (note && pageContent) {
          noteSearchResults.push({
            id: note.id,
            title: note.title,
            body: pageContent, // Use page content instead of note body
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

      // Limit results
      return noteSearchResults.slice(0, validatedOptions.limit);
    } catch (error) {
      console.error('Error searching note pages:', error);
      throw new ServiceError('Failed to search note pages', {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { options },
      });
    }
  }

  /**
   * Combined search for notes and pages
   * @param env Environment bindings
   * @param options Search options
   * @returns Promise<NoteSearchResult[]>
   */
  async search(env: Bindings, options: SearchOptions): Promise<NoteSearchResult[]> {
    try {
      // Search notes
      const noteResults = await this.searchNotes(env, options);

      // Search note pages
      const pageResults = await this.searchNotePages(env, options);

      // Combine results
      const combinedResults = [...noteResults, ...pageResults];

      // Remove duplicates (prefer the higher score if the same note appears multiple times)
      const uniqueResults = combinedResults.reduce((acc, result) => {
        const existing = acc.find(r => r.id === result.id);
        if (!existing) {
          acc.push(result);
        } else if (result.score > existing.score) {
          // Replace with higher score
          const index = acc.indexOf(existing);
          acc[index] = result;
        }
        return acc;
      }, [] as NoteSearchResult[]);

      // Sort by score (highest first)
      uniqueResults.sort((a, b) => b.score - a.score);

      // Limit results
      return uniqueResults.slice(0, options.limit || 10);
    } catch (error) {
      console.error('Error performing combined search:', error);
      throw new ServiceError('Failed to perform combined search', {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { options },
      });
    }
  }
}

// Export singleton instance
export const searchService = new SearchService();
