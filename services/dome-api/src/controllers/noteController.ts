import { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { Bindings } from '../types';
import { UserIdContext } from '../middleware/userIdMiddleware';
import { noteService } from '../services/noteService';
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
 * 
 * This controller handles HTTP requests for note operations and delegates
 * business logic to the NoteService.
 */
export class NoteController {
  /**
   * Ingest content and create a note
   * This endpoint handles natural language input and creates appropriate notes
   * @param c Hono context
   * @returns Response
   */
  async ingest(c: Context<{ Bindings: Bindings; Variables: UserIdContext }>): Promise<Response> {
    getLogger().info({ path: c.req.path, method: c.req.method }, 'Note ingestion started');

    try {
      // Validate request body
      const body = await c.req.json();
      getLogger().debug({ requestBody: body }, 'Received ingest request data');
      const validatedData = ingestSchema.parse(body);

      // Get user ID from context (set by middleware)
      const userId = c.get('userId');

      // Process the content to extract entities and classify intent
      // Generate title if not provided
      const title = validatedData.title || noteService.generateTitle(validatedData.content);
      getLogger().debug({ generatedTitle: title }, 'Generated title for note');

      // Create the note via service
      const note = await noteService.createNote(c.env, {
        userId,
        title,
        body: validatedData.content,
        contentType: validatedData.contentType,
        metadata: validatedData.metadata ? JSON.stringify(validatedData.metadata) : undefined,
      });

      // Extend worker life until embedding finishes
      // The embedding process is handled by the service in the background
      
      // Return the created note
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
  async getNote(c: Context<{ Bindings: Bindings; Variables: UserIdContext }>): Promise<Response> {
    const userId = c.get('userId');
    const noteId = c.req.param('id');

    getLogger().info(
      {
        userId,
        noteId,
        path: c.req.path,
      },
      'Get note request received',
    );

    try {
      // Get the note via service
      const note = await noteService.getNoteById(c.env, noteId, userId);

      // Return the note
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
  async listNotes(c: Context<{ Bindings: Bindings; Variables: UserIdContext }>): Promise<Response> {
    const userId = c.get('userId');

    getLogger().info(
      {
        userId,
        path: c.req.path,
        query: c.req.query(),
      },
      'List notes request received',
    );

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

      // Get notes via service
      const result = await noteService.listNotes(c.env, userId, {
        contentType,
        limit,
        offset,
      });

      // Return the notes
      return c.json({
        success: true,
        notes: result.notes,
        count: result.count,
        total: result.total,
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
  async updateNote(c: Context<{ Bindings: Bindings; Variables: UserIdContext }>): Promise<Response> {
    const userId = c.get('userId');
    const noteId = c.req.param('id');

    getLogger().info(
      {
        userId,
        noteId,
        path: c.req.path,
      },
      'Update note request received',
    );

    try {
      // Validate request body
      const body = await c.req.json();
      getLogger().debug({ requestBody: body }, 'Received update note data');
      
      // Use the schema from the model
      const { updateNoteSchema } = await import('../models/note');
      const validatedData = updateNoteSchema.parse(body);

      // Update the note via service
      const updatedNote = await noteService.updateNote(c.env, noteId, userId, validatedData);

      // Return the updated note
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
  async deleteNote(c: Context<{ Bindings: Bindings; Variables: UserIdContext }>): Promise<Response> {
    const userId = c.get('userId');
    const noteId = c.req.param('id');

    getLogger().info(
      {
        userId,
        noteId,
        path: c.req.path,
      },
      'Delete note request received',
    );

    try {
      // Delete the note via service
      const result = await noteService.deleteNote(c.env, noteId, userId);

      // Return success
      return c.json(result);
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
}

// Export singleton instance
export const noteController = new NoteController();
