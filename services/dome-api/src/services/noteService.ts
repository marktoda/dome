import { Bindings } from '../types';
import { NoteRepository } from '../repositories/noteRepository';
import { Note, CreateNoteData, UpdateNoteData, EmbeddingStatus } from '../models/note';
import { embeddingService } from './embeddingService';
import { getLogger } from '@dome/logging';
import { NotFoundError, ServiceError } from '@dome/common';
import { v4 as uuidv4 } from 'uuid';

/**
 * Service for note operations
 */
export class NoteService {
  private noteRepository: NoteRepository;

  /**
   * Constructor
   */
  constructor() {
    this.noteRepository = new NoteRepository();
  }

  /**
   * Create a new note
   * @param env Environment bindings
   * @param data Note data
   * @param startEmbedding Whether to start the embedding process
   * @returns Created note
   */
  async createNote(
    env: Bindings,
    data: CreateNoteData,
    startEmbedding: boolean = true
  ): Promise<Note> {
    try {
      getLogger().info(
        {
          userId: data.userId,
          contentType: data.contentType,
          contentLength: data.body.length,
        },
        'Creating new note',
      );

      // Create the note
      const note = await this.noteRepository.create(env, data);

      // Start embedding process if requested
      if (startEmbedding) {
        // We don't await this since it's a background process
        this.processEmbedding(env, note.id, note.body, note.userId)
          .catch(err => {
            getLogger().error(
              { err, noteId: note.id, userId: note.userId },
              'Error processing embedding for note',
            );
          });
      }

      getLogger().info({ noteId: note.id }, 'Note successfully created');
      return note;
    } catch (error) {
      getLogger().error(
        { err: error, userId: data.userId },
        'Error creating note',
      );
      throw error;
    }
  }

  /**
   * Get a note by ID
   * @param env Environment bindings
   * @param noteId Note ID
   * @param userId User ID
   * @returns Note
   */
  async getNoteById(env: Bindings, noteId: string, userId: string): Promise<Note> {
    try {
      getLogger().debug({ noteId }, 'Fetching note from repository');
      const note = await this.noteRepository.findById(env, noteId);

      // Check if the note exists and belongs to the user
      if (!note || note.userId !== userId) {
        getLogger().info(
          {
            noteId,
            userId,
            noteExists: !!note,
            noteOwnedByUser: note ? note.userId === userId : false,
          },
          'Note not found or access denied',
        );
        throw new NotFoundError('Note not found');
      }

      getLogger().info({ noteId }, 'Note successfully retrieved');
      return note;
    } catch (error) {
      getLogger().error(
        { err: error, noteId, userId },
        'Error getting note',
      );
      throw error;
    }
  }

  /**
   * List notes for a user
   * @param env Environment bindings
   * @param userId User ID
   * @param options Filter and pagination options
   * @returns List of notes with pagination info
   */
  async listNotes(
    env: Bindings,
    userId: string,
    options: { contentType?: string; limit?: number; offset?: number } = {}
  ): Promise<{ notes: Note[]; count: number; total: number }> {
    try {
      const { contentType, limit = 50, offset = 0 } = options;

      getLogger().debug(
        { userId, contentType, limit, offset },
        'Fetching notes from repository',
      );

      // Get notes for the user
      const notes = await this.noteRepository.findByUserId(env, userId);

      // Filter by content type if specified
      const filteredNotes = contentType
        ? notes.filter(note => note.contentType === contentType)
        : notes;

      // Apply pagination
      const paginatedNotes = filteredNotes.slice(offset, offset + limit);

      getLogger().info(
        {
          count: paginatedNotes.length,
          total: filteredNotes.length,
          contentTypeFilter: contentType || 'none',
        },
        'Notes successfully listed',
      );

      return {
        notes: paginatedNotes,
        count: paginatedNotes.length,
        total: filteredNotes.length,
      };
    } catch (error) {
      getLogger().error(
        { err: error, userId },
        'Error listing notes',
      );
      throw error;
    }
  }

  /**
   * Update a note
   * @param env Environment bindings
   * @param noteId Note ID
   * @param userId User ID
   * @param data Update data
   * @returns Updated note
   */
  async updateNote(
    env: Bindings,
    noteId: string,
    userId: string,
    data: UpdateNoteData
  ): Promise<Note> {
    try {
      // Get the note to check ownership
      getLogger().debug({ noteId }, 'Fetching note to verify ownership');
      const existingNote = await this.noteRepository.findById(env, noteId);

      // Check if the note exists and belongs to the user
      if (!existingNote || existingNote.userId !== userId) {
        getLogger().info(
          {
            noteId,
            userId,
            noteExists: !!existingNote,
            noteOwnedByUser: existingNote ? existingNote.userId === userId : false,
          },
          'Note not found or access denied for update',
        );
        throw new NotFoundError('Note not found');
      }

      // Update the note
      getLogger().info(
        {
          noteId,
          fieldsToUpdate: Object.keys(data),
        },
        'Updating note',
      );
      const updatedNote = await this.noteRepository.update(env, noteId, data);

      // If the body was updated, regenerate the embedding
      if (data.body) {
        getLogger().info({ noteId }, 'Content updated, regenerating embedding');

        // Update embedding status to pending
        await this.noteRepository.update(env, noteId, {
          embeddingStatus: EmbeddingStatus.PENDING,
        });

        // Process embedding in the background
        this.processEmbedding(env, noteId, data.body, userId).catch(error => {
          getLogger().error(
            {
              err: error,
              noteId,
              userId,
            },
            'Error processing embedding for updated note',
          );
        });
      }

      getLogger().info({ noteId }, 'Note successfully updated');
      return updatedNote;
    } catch (error) {
      getLogger().error(
        { err: error, noteId, userId },
        'Error updating note',
      );
      throw error;
    }
  }

  /**
   * Delete a note
   * @param env Environment bindings
   * @param noteId Note ID
   * @param userId User ID
   * @returns Success message
   */
  async deleteNote(env: Bindings, noteId: string, userId: string): Promise<{ success: boolean; message: string }> {
    try {
      // Get the note to check ownership
      getLogger().debug({ noteId }, 'Fetching note to verify ownership before deletion');
      const existingNote = await this.noteRepository.findById(env, noteId);

      // Check if the note exists and belongs to the user
      if (!existingNote || existingNote.userId !== userId) {
        getLogger().info(
          {
            noteId,
            userId,
            noteExists: !!existingNote,
            noteOwnedByUser: existingNote ? existingNote.userId === userId : false,
          },
          'Note not found or access denied for deletion',
        );
        throw new NotFoundError('Note not found');
      }

      // Delete the note
      getLogger().info({ noteId }, 'Deleting note from repository');
      await this.noteRepository.delete(env, noteId);

      getLogger().info({ noteId }, 'Note successfully deleted');
      return {
        success: true,
        message: 'Note deleted successfully',
      };
    } catch (error) {
      getLogger().error(
        { err: error, noteId, userId },
        'Error deleting note',
      );
      throw error;
    }
  }

  /**
   * Generate a title from content
   * @param content Note content
   * @returns Generated title
   */
  generateTitle(content: string): string {
    // Simple title generation - use first few words or first line
    const firstLine = content.split('\n')[0].trim();
    if (firstLine.length <= 50) {
      return firstLine;
    }

    // Use first few words
    const words = content.split(' ').slice(0, 5).join(' ');
    return words.length < 50 ? `${words}...` : words.substring(0, 47) + '...';
  }

  /**
   * Process embedding for a note
   * @param env Environment bindings
   * @param noteId Note ID
   * @param content Note content
   * @param userId User ID
   */
  private async processEmbedding(
    env: Bindings,
    noteId: string,
    content: string,
    userId: string,
  ): Promise<void> {
    try {
      getLogger().debug(
        {
          noteId,
          contentLength: content.length,
        },
        'Starting embedding process',
      );

      // Update embedding status to processing
      await this.noteRepository.update(env, noteId, {
        embeddingStatus: EmbeddingStatus.PROCESSING,
      });

      // Enqueue for embedding via Constellation
      getLogger().debug({ noteId }, 'Enqueuing for embedding');
      await embeddingService.enqueueEmbedding(env, userId, noteId, content);

      getLogger().debug({ noteId }, 'Note enqueued for embedding');

      // Update embedding status to completed
      await this.noteRepository.update(env, noteId, {
        embeddingStatus: EmbeddingStatus.COMPLETED,
      });

      getLogger().info({ noteId }, 'Embedding process completed successfully');
    } catch (error) {
      getLogger().error(
        {
          err: error,
          noteId,
          userId,
        },
        'Error processing embedding for note',
      );

      // Update embedding status to failed
      await this.noteRepository.update(env, noteId, {
        embeddingStatus: EmbeddingStatus.FAILED,
      });

      throw error;
    }
  }
}

// Export singleton instance
export const noteService = new NoteService();