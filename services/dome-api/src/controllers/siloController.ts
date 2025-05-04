import { Context } from 'hono';
import type { Bindings } from '../types';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { SiloClient } from '@dome/silo/client';
import { AiProcessorClient, AiProcessorBinding } from '@dome/ai-processor/client';
import { UserIdContext } from '../middleware/userIdMiddleware';
import { getLogger, metrics } from '@dome/common';
import {
  ServiceError,
  siloSimplePutSchema,
  ContentCategory,
  SiloContentBatch,
  SiloSimplePutInput,
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

const reprocessSchema = z.object({
  id: z.string().optional(),
});

const bulkReprocessSchema = z.object({
  contentIds: z.array(z.string()).min(1, 'At least one content ID is required'),
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
  private logger;

  constructor(private silo: SiloClient, private aiProcessor: AiProcessorClient) {
    this.logger = getLogger();
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

      const note = this.silo.get(id, userId);

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
      const result = await this.silo.batchGet(Object.assign({ userId }, validatedParams));

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

      const notes = await this.silo.batchGet({ ids, userId });

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

      // Create a message for the ingest queue
      const message: SiloSimplePutInput = {
        userId,
        content: validatedData.content,
        category: (validatedData.category || 'note') as ContentCategory,
        mimeType: validatedData.mimeType || 'text/markdown',
        metadata: {
          title,
          ...validatedData.metadata,
        },
      };

      // Send the message to the ingest queue
      await this.silo.uploadSingle(message);

      this.logger.info({ userId, category: message.category }, 'Content sent to ingest queue');

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
      const existingNote = await this.silo.get(noteId, userId);

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
      // Send directly to the ingest queue
      await this.silo.uploadSingle({
        id: noteId,
        content: updatedNote.body || '',
        category: (updatedNote.category || 'note') as ContentCategory,
        mimeType: updatedNote.mimeType || 'text/markdown',
        userId,
      });

      // Get the updated note
      const note = await this.silo.get(noteId, userId);

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

      this.silo.delete({ id, userId });
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

  /**
   * POST /notes/reprocess
   * Reprocess AI metadata for content
   */
  async reprocess(c: Context<{ Bindings: Bindings; Variables: UserIdContext }>): Promise<Response> {
    try {
      const startTime = performance.now();
      this.logger.info({ path: c.req.path, method: c.req.method }, 'Reprocess request received');

      // Parse request body
      let body = {};
      try {
        body = await c.req.json();
      } catch (error) {
        // If body parsing fails, assume empty body (no ID provided)
        body = {};
      }

      // Validate request body
      const validatedData = reprocessSchema.parse(body);
      this.logger.info({ reprocessRequest: validatedData }, 'Validated reprocess request data');

      // Call the AI processor service directly via RPC
      const result = await this.aiProcessor.reprocess(validatedData);

      // Track metrics
      metrics.timing('api.reprocess.latency_ms', performance.now() - startTime);
      metrics.increment('api.reprocess.success', 1);

      return c.json({
        success: true,
        result,
      });
    } catch (error) {
      this.logger.error(
        {
          err: error,
          path: c.req.path,
          method: c.req.method,
        },
        'Error in reprocess controller',
      );

      metrics.increment('api.reprocess.errors', 1);

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

      // Handle errors from the AI processor service
      return c.json(
        {
          success: false,
          error: {
            code: 'REPROCESS_ERROR',
            message: 'Failed to reprocess content',
            details: error instanceof Error ? error.message : String(error),
          },
        },
        500,
      );
    }
  }

  /**
   * POST /notes/bulk-reprocess
   * Reprocess multiple content items by their IDs
   */
  async bulkReprocess(c: Context<{ Bindings: Bindings; Variables: UserIdContext }>): Promise<Response> {
    try {
      const startTime = performance.now();
      this.logger.info({ path: c.req.path, method: c.req.method }, 'Bulk reprocess request received');

      // Parse request body
      const body = await c.req.json();
      
      // Validate request body
      const validatedData = bulkReprocessSchema.parse(body);
      this.logger.info({ 
        bulkReprocessRequest: { 
          contentCount: validatedData.contentIds.length,
          contentIds: validatedData.contentIds
        }
      }, 'Validated bulk reprocess request data');

      // Call the silo service to reprocess the content
      const result = await this.silo.reprocessContent(validatedData.contentIds);

      // Track metrics
      metrics.timing('api.bulk_reprocess.latency_ms', performance.now() - startTime);
      metrics.increment('api.bulk_reprocess.success', 1);
      metrics.gauge('api.bulk_reprocess.content_count', result.reprocessed);

      return c.json({
        success: true,
        result,
      });
    } catch (error) {
      this.logger.error(
        {
          err: error,
          path: c.req.path,
          method: c.req.method,
        },
        'Error in bulk reprocess controller'
      );

      metrics.increment('api.bulk_reprocess.errors', 1);

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
          400
        );
      }

      // Handle errors from the silo service
      return c.json(
        {
          success: false,
          error: {
            code: 'BULK_REPROCESS_ERROR',
            message: 'Failed to reprocess content items',
            details: error instanceof Error ? error.message : String(error),
          },
        },
        500
      );
    }
  }
}
