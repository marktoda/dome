import { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { Bindings } from '../types';
import { NoteRepository } from '../repositories/noteRepository';
import { embeddingService } from '../services/embeddingService';
import { vectorizeService } from '../services/vectorizeService';
import { ServiceError, UnauthorizedError, NotFoundError } from '@dome/common';
import { createNoteSchema, updateNoteSchema, EmbeddingStatus } from '../models/note';
import { v4 as uuidv4 } from 'uuid';
import { getLogger } from '@dome/logging';

/**
 * Ingest request schema
 */
const ingestSchema = z.object({
  content: z.string().min(1, 'Content is required'),
  contentType: z.string().default('text/plain'),
  title: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
  tags: z.array(z.string()).optional(),
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
    getLogger().info({ path: c.req.path, method: c.req.method }, 'Note ingestion started');

    try {
      // Validate request body
      const body = await c.req.json();
      getLogger().debug({ requestBody: body }, 'Received ingest request data');
      const validatedData = ingestSchema.parse(body);

      // Get user ID from request headers or query parameters
      const userId = c.req.header('x-user-id') || c.req.query('userId');
      getLogger().debug({ userId }, 'User ID extracted for note ingestion');

      if (!userId) {
        getLogger().warn({ path: c.req.path }, 'Missing user ID in note ingestion request');
        throw new UnauthorizedError(
          'User ID is required. Provide it via x-user-id header or userId query parameter',
        );
      }

      // Process the content to extract entities and classify intent
      // This would typically involve an LLM call, but for now we'll use a simple approach
      const title = validatedData.title || this.generateTitle(validatedData.content);
      getLogger().debug({ generatedTitle: title }, 'Generated title for note');

      // Create the note
      getLogger().info(
        {
          userId,
          contentType: validatedData.contentType,
          contentLength: validatedData.content.length,
        },
        'Creating new note',
      );
      const note = await this.noteRepository.create(c.env, {
        userId,
        title,
        body: validatedData.content,
        contentType: validatedData.contentType,
        metadata: validatedData.metadata ? JSON.stringify(validatedData.metadata) : undefined,
      });

      // Generate embedding in the background
      getLogger().info({ noteId: note.id }, 'Starting background embedding process');

      // extends workers life until it finishes
      c.executionCtx.waitUntil(
        this.processEmbedding(c.env, note.id, note.body, userId).catch(err =>
          getLogger().error(
            { err, noteId: note.id, userId },
            'Error processing embedding for note',
          ),
        ),
      );

      // Return the created note
      getLogger().info({ noteId: note.id }, 'Note successfully created');
      return c.json(
        {
          success: true,
          note,
        },
        201,
      );
    } catch (error) {
      getLogger().error(
        {
          err: error,
          path: c.req.path,
          method: c.req.method,
        },
        'Error in ingest controller',
      );

      // Let the middleware handle the error
      throw error;
    }
  }

  /**
   * Get a note by ID
   * @param c Hono context
   * @returns Response
   */
  async getNote(c: Context<{ Bindings: Bindings }>): Promise<Response> {
    // Get user ID from request headers or query parameters
    const userId = c.req.header('x-user-id') || c.req.query('userId');
    const noteId = c.req.param('id');

    getLogger().info(
      {
        userId,
        noteId,
        path: c.req.path,
      },
      'Get note request received',
    );

    if (!userId) {
      getLogger().warn({ noteId, path: c.req.path }, 'Missing user ID in get note request');
      throw new UnauthorizedError(
        'User ID is required. Provide it via x-user-id header or userId query parameter',
      );
    }

    try {
      // Get the note
      getLogger().debug({ noteId }, 'Fetching note from repository');
      const note = await this.noteRepository.findById(c.env, noteId);

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

      // Return the note
      getLogger().info({ noteId }, 'Note successfully retrieved');
      return c.json({
        success: true,
        note,
      });
    } catch (error) {
      getLogger().error(
        {
          err: error,
          noteId: c.req.param('id'),
          path: c.req.path,
        },
        'Error getting note',
      );

      // Let the middleware handle the error
      throw error;
    }
  }

  /**
   * List notes for a user
   * @param c Hono context
   * @returns Response
   */
  async listNotes(c: Context<{ Bindings: Bindings }>): Promise<Response> {
    // Get user ID from request headers or query parameters
    const userId = c.req.header('x-user-id') || c.req.query('userId');

    getLogger().info(
      {
        userId,
        path: c.req.path,
        query: c.req.query(),
      },
      'List notes request received',
    );

    if (!userId) {
      getLogger().warn({ path: c.req.path }, 'Missing user ID in list notes request');
      throw new UnauthorizedError(
        'User ID is required. Provide it via x-user-id header or userId query parameter',
      );
    }

    try {
      // Get query parameters for filtering
      const contentType = c.req.query('contentType');
      const limitParam = c.req.query('limit');
      const offsetParam = c.req.query('offset');
      const limit = limitParam ? parseInt(limitParam) : 50;
      const offset = offsetParam ? parseInt(offsetParam) : 0;

      getLogger().debug(
        {
          contentType,
          limit,
          offset,
        },
        'List notes query parameters',
      );

      // Get notes for the user
      getLogger().debug({ userId }, 'Fetching notes from repository');
      const notes = await this.noteRepository.findByUserId(c.env, userId);

      // Filter by content type if specified
      const filteredNotes = contentType
        ? notes.filter(note => note.contentType === contentType)
        : notes;

      // Apply pagination
      const paginatedNotes = filteredNotes.slice(offset, offset + limit);

      // Return the notes
      getLogger().info(
        {
          count: paginatedNotes.length,
          total: filteredNotes.length,
          contentTypeFilter: contentType || 'none',
        },
        'Notes successfully listed',
      );

      return c.json({
        success: true,
        notes: paginatedNotes,
        count: paginatedNotes.length,
        total: filteredNotes.length,
      });
    } catch (error) {
      getLogger().error(
        {
          err: error,
          userId,
          path: c.req.path,
        },
        'Error listing notes',
      );

      // Let the middleware handle the error
      throw error;
    }
  }

  /**
   * Update a note
   * @param c Hono context
   * @returns Response
   */
  async updateNote(c: Context<{ Bindings: Bindings }>): Promise<Response> {
    // Get user ID from request headers or query parameters
    const userId = c.req.header('x-user-id') || c.req.query('userId');
    const noteId = c.req.param('id');

    getLogger().info(
      {
        userId,
        noteId,
        path: c.req.path,
      },
      'Update note request received',
    );

    if (!userId) {
      getLogger().warn({ noteId, path: c.req.path }, 'Missing user ID in update note request');
      throw new UnauthorizedError(
        'User ID is required. Provide it via x-user-id header or userId query parameter',
      );
    }

    try {
      // Get the note to check ownership
      getLogger().debug({ noteId }, 'Fetching note to verify ownership');
      const existingNote = await this.noteRepository.findById(c.env, noteId);

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

      // Validate request body
      const body = await c.req.json();
      getLogger().debug({ requestBody: body }, 'Received update note data');
      const validatedData = updateNoteSchema.parse(body);

      // Update the note
      getLogger().info(
        {
          noteId,
          fieldsToUpdate: Object.keys(validatedData),
        },
        'Updating note',
      );
      const updatedNote = await this.noteRepository.update(c.env, noteId, validatedData);

      // If the body was updated, regenerate the embedding
      if (validatedData.body) {
        getLogger().info({ noteId }, 'Content updated, regenerating embedding');

        // Update embedding status to pending
        await this.noteRepository.update(c.env, noteId, {
          embeddingStatus: EmbeddingStatus.PENDING,
        });

        // Process embedding in the background
        this.processEmbedding(c.env, noteId, validatedData.body, userId).catch(error => {
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

      // Return the updated note
      getLogger().info({ noteId }, 'Note successfully updated');
      return c.json({
        success: true,
        note: updatedNote,
      });
    } catch (error) {
      getLogger().error(
        {
          err: error,
          noteId: c.req.param('id'),
          path: c.req.path,
        },
        'Error updating note',
      );

      // Let the middleware handle the error
      throw error;
    }
  }

  /**
   * Delete a note
   * @param c Hono context
   * @returns Response
   */
  async deleteNote(c: Context<{ Bindings: Bindings }>): Promise<Response> {
    // Get user ID from request headers or query parameters
    const userId = c.req.header('x-user-id') || c.req.query('userId');
    const noteId = c.req.param('id');

    getLogger().info(
      {
        userId,
        noteId,
        path: c.req.path,
      },
      'Delete note request received',
    );

    if (!userId) {
      getLogger().warn({ noteId, path: c.req.path }, 'Missing user ID in delete note request');
      throw new UnauthorizedError(
        'User ID is required. Provide it via x-user-id header or userId query parameter',
      );
    }

    try {
      // Get the note to check ownership
      getLogger().debug({ noteId }, 'Fetching note to verify ownership before deletion');
      const existingNote = await this.noteRepository.findById(c.env, noteId);

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
      await this.noteRepository.delete(c.env, noteId);

      // Return success
      getLogger().info({ noteId }, 'Note successfully deleted');
      return c.json({
        success: true,
        message: 'Note deleted successfully',
      });
    } catch (error) {
      getLogger().error(
        {
          err: error,
          noteId: c.req.param('id'),
          path: c.req.path,
        },
        'Error deleting note',
      );

      // Let the middleware handle the error
      throw error;
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
export const noteController = new NoteController();
