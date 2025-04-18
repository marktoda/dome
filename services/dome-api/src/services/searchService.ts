import { Bindings } from '../types';
import { Note } from '../models/note';
import { NoteRepository } from '../repositories/noteRepository';
import { vectorizeService, SearchResult } from './vectorizeService';
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
 * Service for searching notes using Constellation
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
   * Search notes using semantic search via Constellation
   * @param env Environment bindings
   * @param options Search options
   * @returns Promise<NoteSearchResult[]>
   */
  async searchNotes(env: Bindings, options: SearchOptions): Promise<NoteSearchResult[]> {
    try {
      // Validate options
      const validatedOptions = searchOptionsSchema.parse(options);

      // Build filter for Constellation query
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
   * Combined search for notes
   * @param env Environment bindings
   * @param options Search options
   * @returns Promise<NoteSearchResult[]>
   */
  async search(env: Bindings, options: SearchOptions): Promise<NoteSearchResult[]> {
    // With Constellation, we can just use the searchNotes method
    return this.searchNotes(env, options);
  }
}

// Export singleton instance
export const searchService = new SearchService();
