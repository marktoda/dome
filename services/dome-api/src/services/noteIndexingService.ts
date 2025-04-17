import { Bindings } from '../types';
import { Note, NotePage, EmbeddingStatus } from '../models/note';
import { NoteRepository } from '../repositories/noteRepository';
import { vectorizeService, VectorMetadata } from './vectorizeService';
import { embeddingService } from './embeddingService';
import { ServiceError } from '@dome/common';

/**
 * Service for indexing notes in Vectorize
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
   * Index a note in Vectorize
   * @param env Environment bindings
   * @param note Note to index
   * @returns Promise<void>
   */
  async indexNote(env: Bindings, note: Note): Promise<void> {
    try {
      // Update note status to processing
      await this.noteRepository.update(env, note.id, {
        embeddingStatus: EmbeddingStatus.PROCESSING
      });
      
      // Generate embedding for the note body
      const embedding = await embeddingService.generateEmbedding(env, note.body);
      
      // Create metadata for the vector
      const metadata: VectorMetadata = {
        userId: note.userId,
        noteId: note.id,
        createdAt: note.createdAt
      };
      
      // Add vector to Vectorize
      await vectorizeService.addVector(env, note.id, embedding, metadata);
      
      // Update note status to completed
      await this.noteRepository.update(env, note.id, {
        embeddingStatus: EmbeddingStatus.COMPLETED
      });
    } catch (error) {
      console.error(`Error indexing note ${note.id}:`, error);
      
      // Update note status to failed
      await this.noteRepository.update(env, note.id, {
        embeddingStatus: EmbeddingStatus.FAILED
      });
      
      throw new ServiceError(`Failed to index note ${note.id}`, {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { noteId: note.id }
      });
    }
  }
  
  /**
   * Index note pages in Vectorize
   * @param env Environment bindings
   * @param note Note
   * @param pages Note pages to index
   * @returns Promise<void>
   */
  async indexNotePages(env: Bindings, note: Note, pages: NotePage[]): Promise<void> {
    try {
      // Update note status to processing
      await this.noteRepository.update(env, note.id, {
        embeddingStatus: EmbeddingStatus.PROCESSING
      });
      
      // Generate embeddings for each page in batches
      const pageContents = pages.map(page => page.content);
      const embeddings = await embeddingService.generateEmbeddings(env, pageContents);
      
      // Add vectors to Vectorize
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        const embedding = embeddings[i];
        
        // Create metadata for the vector
        const metadata: VectorMetadata = {
          userId: note.userId,
          noteId: note.id,
          createdAt: note.createdAt,
          pageNum: page.pageNum
        };
        
        // Add vector to Vectorize
        await vectorizeService.addVector(env, page.id, embedding, metadata);
      }
      
      // Update note status to completed
      await this.noteRepository.update(env, note.id, {
        embeddingStatus: EmbeddingStatus.COMPLETED
      });
    } catch (error) {
      console.error(`Error indexing note pages for note ${note.id}:`, error);
      
      // Update note status to failed
      await this.noteRepository.update(env, note.id, {
        embeddingStatus: EmbeddingStatus.FAILED
      });
      
      throw new ServiceError(`Failed to index note pages for note ${note.id}`, {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { noteId: note.id, pagesCount: pages.length }
      });
    }
  }
  
  /**
   * Update note index in Vectorize
   * @param env Environment bindings
   * @param note Note to update
   * @returns Promise<void>
   */
  async updateNoteIndex(env: Bindings, note: Note): Promise<void> {
    try {
      // Update note status to processing
      await this.noteRepository.update(env, note.id, {
        embeddingStatus: EmbeddingStatus.PROCESSING
      });
      
      // Generate embedding for the note body
      const embedding = await embeddingService.generateEmbedding(env, note.body);
      
      // Create metadata for the vector
      const metadata: VectorMetadata = {
        userId: note.userId,
        noteId: note.id,
        createdAt: note.createdAt
      };
      
      // Update vector in Vectorize
      await vectorizeService.updateVector(env, note.id, embedding, metadata);
      
      // Update note status to completed
      await this.noteRepository.update(env, note.id, {
        embeddingStatus: EmbeddingStatus.COMPLETED
      });
    } catch (error) {
      console.error(`Error updating note index for note ${note.id}:`, error);
      
      // Update note status to failed
      await this.noteRepository.update(env, note.id, {
        embeddingStatus: EmbeddingStatus.FAILED
      });
      
      throw new ServiceError(`Failed to update note index for note ${note.id}`, {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { noteId: note.id }
      });
    }
  }
  
  /**
   * Delete note index from Vectorize
   * @param env Environment bindings
   * @param noteId Note ID
   * @returns Promise<void>
   */
  async deleteNoteIndex(env: Bindings, noteId: string): Promise<void> {
    try {
      // Delete vector from Vectorize
      await vectorizeService.deleteVector(env, noteId);
      
      // Get note pages
      const pages = await this.noteRepository.findPagesByNoteId(env, noteId);
      
      // Delete page vectors from Vectorize
      for (const page of pages) {
        await vectorizeService.deleteVector(env, page.id);
      }
    } catch (error) {
      console.error(`Error deleting note index for note ${noteId}:`, error);
      throw new ServiceError(`Failed to delete note index for note ${noteId}`, {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { noteId }
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
      const result = await db.prepare(`
        SELECT * FROM notes 
        WHERE embeddingStatus = ? 
        ORDER BY createdAt ASC
        LIMIT ?
      `)
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
        cause: error instanceof Error ? error : new Error(String(error))
      });
    }
  }
}

// Export singleton instance
export const noteIndexingService = new NoteIndexingService();