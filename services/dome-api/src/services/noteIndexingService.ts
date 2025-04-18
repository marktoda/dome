import { Bindings } from '../types';
import { Note, NotePage, EmbeddingStatus } from '../models/note';
import { NoteRepository } from '../repositories/noteRepository';
import { embeddingService } from './embeddingService';
import { ServiceError } from '@dome/common';

/**
 * Service for indexing notes using the Constellation embedding service
 */
export class NoteIndexingService {
  private noteRepository: NoteRepository;

  /**
   * Constructor
   */
  constructor() {
    this.noteRepository = new NoteRepository();
  }

  /**
   * Index a note using Constellation
   * @param env Environment bindings
   * @param note Note to index
   * @returns Promise<void>
   */
  async indexNote(env: Bindings, note: Note): Promise<void> {
    try {
      // Update note status to processing
      await this.noteRepository.update(env, note.id, {
        embeddingStatus: EmbeddingStatus.PROCESSING,
      });

      // Enqueue the note for embedding
      await embeddingService.enqueueEmbedding(env, note.userId, note.id, note.body);

      // Update note status to completed
      // Note: In a real implementation, we might want to use a webhook or polling
      // to update the status when the embedding is actually complete
      await this.noteRepository.update(env, note.id, {
        embeddingStatus: EmbeddingStatus.COMPLETED,
      });
    } catch (error) {
      console.error(`Error indexing note ${note.id}:`, error);

      // Update note status to failed
      await this.noteRepository.update(env, note.id, {
        embeddingStatus: EmbeddingStatus.FAILED,
      });

      throw new ServiceError(`Failed to index note ${note.id}`, {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { noteId: note.id },
      });
    }
  }

  /**
   * Index note pages using Constellation
   * @param env Environment bindings
   * @param note Note
   * @param pages Note pages to index
   * @returns Promise<void>
   */
  async indexNotePages(env: Bindings, note: Note, pages: NotePage[]): Promise<void> {
    try {
      // Update note status to processing
      await this.noteRepository.update(env, note.id, {
        embeddingStatus: EmbeddingStatus.PROCESSING,
      });

      // Enqueue each page for embedding
      for (const page of pages) {
        await embeddingService.enqueueEmbedding(
          env,
          note.userId,
          `${note.id}:page:${page.pageNum}`,
          page.content,
        );
      }

      // Update note status to completed
      await this.noteRepository.update(env, note.id, {
        embeddingStatus: EmbeddingStatus.COMPLETED,
      });
    } catch (error) {
      console.error(`Error indexing note pages for note ${note.id}:`, error);

      // Update note status to failed
      await this.noteRepository.update(env, note.id, {
        embeddingStatus: EmbeddingStatus.FAILED,
      });

      throw new ServiceError(`Failed to index note pages for note ${note.id}`, {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { noteId: note.id, pagesCount: pages.length },
      });
    }
  }

  /**
   * Update note index using Constellation
   * @param env Environment bindings
   * @param note Note to update
   * @returns Promise<void>
   */
  async updateNoteIndex(env: Bindings, note: Note): Promise<void> {
    try {
      // Update note status to processing
      await this.noteRepository.update(env, note.id, {
        embeddingStatus: EmbeddingStatus.PROCESSING,
      });

      // Enqueue the note for embedding (will overwrite existing vectors)
      await embeddingService.enqueueEmbedding(env, note.userId, note.id, note.body);

      // Update note status to completed
      await this.noteRepository.update(env, note.id, {
        embeddingStatus: EmbeddingStatus.COMPLETED,
      });
    } catch (error) {
      console.error(`Error updating note index for note ${note.id}:`, error);

      // Update note status to failed
      await this.noteRepository.update(env, note.id, {
        embeddingStatus: EmbeddingStatus.FAILED,
      });

      throw new ServiceError(`Failed to update note index for note ${note.id}`, {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { noteId: note.id },
      });
    }
  }

  /**
   * Process pending notes for indexing
   * @param env Environment bindings
   * @param limit Maximum number of notes to process
   * @returns Promise<number> Number of notes processed
   */
  async processPendingNotes(env: Bindings, limit = 10): Promise<number> {
    try {
      // Find notes with pending embedding status
      const db = await env.D1_DATABASE;
      const result = await db
        .prepare(
          `
        SELECT * FROM notes 
        WHERE embeddingStatus = ? 
        ORDER BY createdAt ASC
        LIMIT ?
      `,
        )
        .bind(EmbeddingStatus.PENDING, limit)
        .all();

      const pendingNotes = result.results as Note[];

      // Process each note
      for (const note of pendingNotes) {
        try {
          // Check if note has pages
          const pages = await this.noteRepository.findPagesByNoteId(env, note.id);

          if (pages.length > 0) {
            // Index note pages
            await this.indexNotePages(env, note, pages);
          } else {
            // Index note
            await this.indexNote(env, note);
          }
        } catch (error) {
          console.error(`Error processing pending note ${note.id}:`, error);
          // Continue with next note
        }
      }

      return pendingNotes.length;
    } catch (error) {
      console.error('Error processing pending notes:', error);
      throw new ServiceError('Failed to process pending notes', {
        cause: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
}

// Export singleton instance
export const noteIndexingService = new NoteIndexingService();
