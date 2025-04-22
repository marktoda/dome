import { Context } from 'hono';
import type { Bindings } from '../types';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { siloService } from '../services/siloService';
import { UserIdContext } from '../middleware/userIdMiddleware';
import { getLogger } from '@dome/logging';
import {
  ServiceError,
  siloSimplePutSchema,
  ContentCategory,
  SiloBatchGetResponse,
} from '@dome/common';

/**
 * Validation schemas for Silo endpoints
 */
const ingestSchema = z.object({
  content: z.string().min(1, 'Content is required'),
  category: z.string().default('note'),
  mimeType: z.string().default('text/markdown'),
  title: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
  tags: z.array(z.string()).optional(),
});

const updateNoteSchema = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
  category: z.string().optional(),
  mimeType: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

const listNotesSchema = z.object({
  category: z.string().optional(),
  limit: z.coerce.number().int().positive().optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

/**
 * Controller for Silo content operations
 * Handles all note operations using the siloService
 */
export class SiloController {
  private logger = getLogger();

  /**
   * POST /notes
   * Proxy to Silo.simplePut
   */
  async simplePut(c: Context<{ Bindings: Bindings; Variables: UserIdContext }>): Promise<Response> {
    try {
      const userId = c.get('userId');
      const body = await c.req.json();
      const data = siloSimplePutSchema.parse(body);
      const result = await siloService.simplePut(c.env, {
        ...data,
        userId,
      });
      return c.json({ success: true, id: result.id }, 201);
    } catch (error) {
      this.logger.error(
        {
          err: error,
          path: c.req.path,
          method: c.req.method,
        },
        'Error in simplePut controller',
      );

      if (error instanceof z.ZodError) {
        return c.json(
          {
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid request data',
              details: error.errors,
            },
          },
          400,
        );
      }

      throw error;
    }
  }

  /**
   * GET /notes/:id
   * Get a single note by ID
   */
  async get(c: Context<{ Bindings: Bindings; Variables: UserIdContext }>): Promise<Response> {
    try {
      const userId = c.get('userId');
      const id = c.req.param('id');

      this.logger.info(
        {
          userId,
          noteId: id,
          path: c.req.path,
        },
        'Get note request received',
      );

      const note = await siloService.batchGet(c.env, { ids: [id], userId });

      if (!note) {
        return c.json(
          {
            success: false,
            error: { code: 'NOT_FOUND', message: 'Note not found' },
          },
          404,
        );
      }

      return c.json({ success: true, note });
    } catch (error) {
      this.logger.error(
        {
          err: error,
          noteId: c.req.param('id'),
          path: c.req.path,
        },
        'Error getting note',
      );

      if (error instanceof ServiceError) {
        const statusCode = error.status || 500;
        return c.json(
          {
            success: false,
            error: {
              code: error.code || 'NOTE_ERROR',
              message: error.message,
            },
          },
          statusCode as any,
        );
      }

      throw error;
    }
  }

  /**
   * GET /notes
   * List notes with optional filtering
   */
  async listNotes(c: Context<{ Bindings: Bindings; Variables: UserIdContext }>): Promise<Response> {
    try {
      const userId = c.get('userId');

      this.logger.info(
        {
          userId,
          path: c.req.path,
          query: c.req.query(),
        },
        'List notes request received',
      );

      // Validate and parse query parameters
      const validatedParams = listNotesSchema.parse(c.req.query());

      // Call the siloService to list notes
      const result = await siloService.batchGet(c.env, Object.assign({ userId }, validatedParams));

      return c.json({
        success: true,
        notes: result.items,
        count: result.items,
        total: result.total,
        limit: result.limit,
        offset: result.offset,
      });
    } catch (error) {
      this.logger.error(
        {
          err: error,
          userId: c.get('userId'),
          path: c.req.path,
        },
        'Error listing notes',
      );

      if (error instanceof z.ZodError) {
        return c.json(
          {
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid query parameters',
              details: error.errors,
            },
          },
          400,
        );
      }

      throw error;
    }
  }

  /**
   * GET /notes/batch
   * Batch get notes by IDs
   */
  async batchGet(c: Context<{ Bindings: Bindings; Variables: UserIdContext }>): Promise<Response> {
    try {
      const userId = c.get('userId');
      const ids = c.req.query('ids')?.split(',') || [];

      if (ids.length === 0) {
        return c.json(
          {
            success: false,
            error: { code: 'BAD_REQUEST', message: 'No IDs provided' },
          },
          400,
        );
      }

      const notes = await siloService.batchGet(c.env, { ids, userId });

      return c.json({
        success: true,
        notes,
      });
    } catch (error) {
      this.logger.error(
        {
          err: error,
          path: c.req.path,
        },
        'Error in batchGet controller',
      );

      throw error;
    }
  }

  /**
   * POST /notes/ingest
   * Ingest content and create a note
   */
  async ingest(c: Context<{ Bindings: Bindings; Variables: UserIdContext }>): Promise<Response> {
    try {
      this.logger.info({ path: c.req.path, method: c.req.method }, 'Note ingestion started');

      // Validate request body
      const body = await c.req.json();
      this.logger.info({ requestBody: body }, 'Received ingest request data');
      const validatedData = ingestSchema.parse(body);
      this.logger.info({ ingestRequest: validatedData }, 'Validated Ingest data');

      // Get user ID from context (set by middleware)
      const userId = c.get('userId');

      // Generate title if not provided
      const title = validatedData.title || validatedData.content.split('\n')[0].substring(0, 50);
      this.logger.debug({ generatedTitle: title }, 'Generated title for note');

      // Create the note via siloService
      await siloService.simplePut(c.env, {
        content: validatedData.content,
        category: (validatedData.category || 'note') as ContentCategory,
        mimeType: validatedData.mimeType || 'text/markdown',
        userId,
      });

      // Return the created note
      return c.json(
        {
          success: true,
        },
        201,
      );
    } catch (error) {
      this.logger.error(
        {
          err: error,
          path: c.req.path,
          method: c.req.method,
        },
        'Error in ingest controller',
      );

      if (error instanceof z.ZodError) {
        return c.json(
          {
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid request data',
              details: error.errors,
            },
          },
          400,
        );
      }

      throw error;
    }
  }

  /**
   * PUT /notes/:id
   * Update a note
   */
  async updateNote(
    c: Context<{ Bindings: Bindings; Variables: UserIdContext }>,
  ): Promise<Response> {
    try {
      const userId = c.get('userId');
      const noteId = c.req.param('id');

      this.logger.info(
        {
          userId,
          noteId,
          path: c.req.path,
        },
        'Update note request received',
      );

      // Get the existing note
      const existingNote = await siloService.get(c.env, { id: noteId, userId });

      // Validate request body
      const body = await c.req.json();
      this.logger.debug({ requestBody: body }, 'Received update note data');
      const validatedData = updateNoteSchema.parse(body);

      // Merge existing note with updates
      const updatedNote = {
        ...existingNote,
        ...validatedData,
      };

      // Update the note via siloService
      await siloService.simplePut(c.env, {
        id: noteId,
        content: updatedNote.body || '',
        category: (updatedNote.category || 'note') as ContentCategory,
        mimeType: updatedNote.mimeType || 'text/markdown',
        userId,
      });

      // Get the updated note
      const note = await siloService.get(c.env, { id: noteId, userId });

      // Return the updated note
      return c.json({
        success: true,
        note,
      });
    } catch (error) {
      this.logger.error(
        {
          err: error,
          noteId: c.req.param('id'),
          path: c.req.path,
        },
        'Error updating note',
      );

      if (error instanceof z.ZodError) {
        return c.json(
          {
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid request data',
              details: error.errors,
            },
          },
          400,
        );
      }

      throw error;
    }
  }

  /**
   * DELETE /notes/:id
   * Delete a note
   */
  async delete(c: Context<{ Bindings: Bindings; Variables: UserIdContext }>): Promise<Response> {
    try {
      const userId = c.get('userId');
      const id = c.req.param('id');

      this.logger.info(
        {
          userId,
          noteId: id,
          path: c.req.path,
        },
        'Delete note request received',
      );

      await siloService.delete(c.env, { id, userId });
      return c.json({ success: true });
    } catch (error) {
      this.logger.error(
        {
          err: error,
          noteId: c.req.param('id'),
          path: c.req.path,
        },
        'Error deleting note',
      );

      if (error instanceof ServiceError) {
        const statusCode = error.status || 500;
        return c.json(
          {
            success: false,
            error: {
              code: error.code || 'DELETE_ERROR',
              message: error.message,
            },
          },
          statusCode as any,
        );
      }

      throw error;
    }
  }
}

export const siloController = new SiloController();
