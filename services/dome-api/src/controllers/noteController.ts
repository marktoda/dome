import { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { Bindings } from '../types';
import { NoteRepository } from '../repositories/noteRepository';
import { embeddingService } from '../services/embeddingService';
import { vectorizeService } from '../services/vectorizeService';
import { ServiceError } from '@dome/common';
import { createNoteSchema, updateNoteSchema, EmbeddingStatus } from '../models/note';
import { v4 as uuidv4 } from 'uuid';

/**
 * Ingest request schema
 */
const ingestSchema = z.object({
  content: z.string().min(1, 'Content is required'),
  contentType: z.string().default('text/plain'),
  title: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
  tags: z.array(z.string()).optional()
});

/**
 * Controller for note operations
 */
export class NoteController {
  private noteRepository: NoteRepository;

  /**
   * Constructor
   */
  constructor() {
    this.noteRepository = new NoteRepository();
  }

  /**
   * Ingest content and create a note
   * This endpoint handles natural language input and creates appropriate notes
   * @param c Hono context
   * @returns Response
   */
  async ingest(c: Context<{ Bindings: Bindings }>): Promise<Response> {
    console.log("hi im ingestin");
    try {
      // Validate request body
      const body = await c.req.json();
      const validatedData = ingestSchema.parse(body);

      // Get user ID from request headers or query parameters
      const userId = c.req.header('x-user-id') || c.req.query('userId');
      if (!userId) {
        return c.json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'User ID is required. Provide it via x-user-id header or userId query parameter'
          }
        }, 401);
      }

      // Process the content to extract entities and classify intent
      // This would typically involve an LLM call, but for now we'll use a simple approach
      const title = validatedData.title || this.generateTitle(validatedData.content);

      // Create the note
      const note = await this.noteRepository.create(c.env, {
        userId,
        title,
        body: validatedData.content,
        contentType: validatedData.contentType,
        metadata: validatedData.metadata ? JSON.stringify(validatedData.metadata) : undefined
      });

      // Generate embedding in the background
      this.processEmbedding(c.env, note.id, note.body, userId)
        .catch(error => console.error(`Error processing embedding for note ${note.id}:`, error));

      // Return the created note
      return c.json({
        success: true,
        note
      }, 201);
    } catch (error) {
      console.error('Error in ingest controller:', error);

      if (error instanceof z.ZodError) {
        return c.json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request data',
            details: error.errors
          }
        }, 400);
      }

      if (error instanceof ServiceError) {
        return c.json({
          success: false,
          error: {
            code: 'SERVICE_ERROR',
            message: error.message
          }
        }, 500);
      }

      return c.json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred during ingestion'
        }
      }, 500);
    }
  }

  /**
   * Get a note by ID
   * @param c Hono context
   * @returns Response
   */
  async getNote(c: Context<{ Bindings: Bindings }>): Promise<Response> {
    try {
      // Get user ID from request headers or query parameters
      const userId = c.req.header('x-user-id') || c.req.query('userId');
      if (!userId) {
        return c.json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'User ID is required. Provide it via x-user-id header or userId query parameter'
          }
        }, 401);
      }

      // Get note ID from path
      const noteId = c.req.param('id');

      // Get the note
      const note = await this.noteRepository.findById(c.env, noteId);

      // Check if the note exists and belongs to the user
      if (!note || note.userId !== userId) {
        return c.json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Note not found'
          }
        }, 404);
      }

      // Return the note
      return c.json({
        success: true,
        note
      });
    } catch (error) {
      console.error('Error getting note:', error);

      if (error instanceof ServiceError) {
        return c.json({
          success: false,
          error: {
            code: 'SERVICE_ERROR',
            message: error.message
          }
        }, 500);
      }

      return c.json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred while retrieving the note'
        }
      }, 500);
    }
  }

  /**
   * List notes for a user
   * @param c Hono context
   * @returns Response
   */
  async listNotes(c: Context<{ Bindings: Bindings }>): Promise<Response> {
    try {
      // Get user ID from request headers or query parameters
      const userId = c.req.header('x-user-id') || c.req.query('userId');
      if (!userId) {
        return c.json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'User ID is required. Provide it via x-user-id header or userId query parameter'
          }
        }, 401);
      }

      // Get query parameters for filtering
      const contentType = c.req.query('contentType');
      const limitParam = c.req.query('limit');
      const offsetParam = c.req.query('offset');
      const limit = limitParam ? parseInt(limitParam) : 50;
      const offset = offsetParam ? parseInt(offsetParam) : 0;

      // Get notes for the user
      const notes = await this.noteRepository.findByUserId(c.env, userId);

      // Filter by content type if specified
      const filteredNotes = contentType
        ? notes.filter(note => note.contentType === contentType)
        : notes;

      // Apply pagination
      const paginatedNotes = filteredNotes.slice(offset, offset + limit);

      // Return the notes
      return c.json({
        success: true,
        notes: paginatedNotes,
        count: paginatedNotes.length,
        total: filteredNotes.length
      });
    } catch (error) {
      console.error('Error listing notes:', error);

      if (error instanceof ServiceError) {
        return c.json({
          success: false,
          error: {
            code: 'SERVICE_ERROR',
            message: error.message
          }
        }, 500);
      }

      return c.json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred while listing notes'
        }
      }, 500);
    }
  }

  /**
   * Update a note
   * @param c Hono context
   * @returns Response
   */
  async updateNote(c: Context<{ Bindings: Bindings }>): Promise<Response> {
    try {
      // Get user ID from request headers or query parameters
      const userId = c.req.header('x-user-id') || c.req.query('userId');
      if (!userId) {
        return c.json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'User ID is required. Provide it via x-user-id header or userId query parameter'
          }
        }, 401);
      }

      // Get note ID from path
      const noteId = c.req.param('id');

      // Get the note to check ownership
      const existingNote = await this.noteRepository.findById(c.env, noteId);

      // Check if the note exists and belongs to the user
      if (!existingNote || existingNote.userId !== userId) {
        return c.json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Note not found'
          }
        }, 404);
      }

      // Validate request body
      const body = await c.req.json();
      const validatedData = updateNoteSchema.parse(body);

      // Update the note
      const updatedNote = await this.noteRepository.update(c.env, noteId, validatedData);

      // If the body was updated, regenerate the embedding
      if (validatedData.body) {
        // Update embedding status to pending
        await this.noteRepository.update(c.env, noteId, {
          embeddingStatus: EmbeddingStatus.PENDING
        });

        // Process embedding in the background
        this.processEmbedding(c.env, noteId, validatedData.body, userId)
          .catch(error => console.error(`Error processing embedding for note ${noteId}:`, error));
      }

      // Return the updated note
      return c.json({
        success: true,
        note: updatedNote
      });
    } catch (error) {
      console.error('Error updating note:', error);

      if (error instanceof z.ZodError) {
        return c.json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid update data',
            details: error.errors
          }
        }, 400);
      }

      if (error instanceof ServiceError) {
        return c.json({
          success: false,
          error: {
            code: 'SERVICE_ERROR',
            message: error.message
          }
        }, 500);
      }

      return c.json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred while updating the note'
        }
      }, 500);
    }
  }

  /**
   * Delete a note
   * @param c Hono context
   * @returns Response
   */
  async deleteNote(c: Context<{ Bindings: Bindings }>): Promise<Response> {
    try {
      // Get user ID from request headers or query parameters
      const userId = c.req.header('x-user-id') || c.req.query('userId');
      if (!userId) {
        return c.json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'User ID is required. Provide it via x-user-id header or userId query parameter'
          }
        }, 401);
      }

      // Get note ID from path
      const noteId = c.req.param('id');

      // Get the note to check ownership
      const existingNote = await this.noteRepository.findById(c.env, noteId);

      // Check if the note exists and belongs to the user
      if (!existingNote || existingNote.userId !== userId) {
        return c.json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Note not found'
          }
        }, 404);
      }

      // Delete the note
      await this.noteRepository.delete(c.env, noteId);

      // Delete the embedding from Vectorize
      try {
        await vectorizeService.deleteVector(c.env, noteId);
      } catch (error) {
        console.warn(`Error deleting vector for note ${noteId}:`, error);
        // Continue even if vector deletion fails
      }

      // Return success
      return c.json({
        success: true,
        message: 'Note deleted successfully'
      });
    } catch (error) {
      console.error('Error deleting note:', error);

      if (error instanceof ServiceError) {
        return c.json({
          success: false,
          error: {
            code: 'SERVICE_ERROR',
            message: error.message
          }
        }, 500);
      }

      return c.json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred while deleting the note'
        }
      }, 500);
    }
  }

  /**
   * Generate a title from content
   * @param content Note content
   * @returns Generated title
   */
  private generateTitle(content: string): string {
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
  private async processEmbedding(env: Bindings, noteId: string, content: string, userId: string): Promise<void> {
    try {
      // Update embedding status to processing
      await this.noteRepository.update(env, noteId, {
        embeddingStatus: EmbeddingStatus.PROCESSING
      });

      // Generate embedding
      const embedding = await embeddingService.generateEmbedding(env, content);

      // Store embedding in Vectorize
      await vectorizeService.addVector(env, noteId, embedding, {
        noteId,
        userId,
        createdAt: Date.now()
      });

      // Update embedding status to completed
      await this.noteRepository.update(env, noteId, {
        embeddingStatus: EmbeddingStatus.COMPLETED
      });
    } catch (error) {
      console.error(`Error processing embedding for note ${noteId}:`, error);

      // Update embedding status to failed
      await this.noteRepository.update(env, noteId, {
        embeddingStatus: EmbeddingStatus.FAILED
      });

      throw error;
    }
  }
}

// Export singleton instance
export const noteController = new NoteController();
