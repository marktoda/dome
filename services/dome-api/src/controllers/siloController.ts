import { Context } from 'hono';
import { z, createRoute, OpenAPIHono, RouteConfigToTypedResponse } from '@hono/zod-openapi';
import { getLogger } from '@dome/common';
import { createServiceFactory } from '../services/serviceFactory';
import type { AppEnv } from '../types';
import { authenticationMiddleware, AuthContext } from '../middleware/authenticationMiddleware';

// Types imported from @dome/common (effectively from packages/common/src/types/siloContent.ts)
import {
  SiloSimplePutInput,
  // SiloSimplePutResponse,
  // SiloSimplePutInput, // Removed duplicate
  SiloBatchGetInput,
  SiloContentBatch,
  SiloDeleteInput,
  SiloContentItem,
  ContentCategoryEnum,
  MimeTypeSchema,
} from '@dome/common';

const logger = getLogger().child({ component: 'SiloController' });

// --- Generic Error Schema ---
const ErrorDetailSchema = z.object({
  code: z.string().openapi({ example: 'NOT_FOUND' }),
  message: z.string().openapi({ example: 'Resource not found' }),
});

const ErrorResponseSchema = z
  .object({
    success: z.literal(false).openapi({ example: false }),
    error: ErrorDetailSchema,
  })
  .openapi('ErrorResponse');

// --- API Specific Schemas ---
const NoteIdParamSchema = z.object({
  id: z.string().openapi({
    param: { name: 'id', in: 'path' },
    example: 'note_123abc',
    description: 'The unique identifier for the note.',
  }),
});

// API's representation of a Note, derived from SiloContentItem
const NoteSchema = z
  .object({
    id: z.string().openapi({ example: 'note_123abc' }),
    userId: z.string().nullable().openapi({ example: 'user_xyz' }),
    category: ContentCategoryEnum.openapi({ example: 'note' }),
    title: z.string().optional().nullable().openapi({ example: 'My Note Title' }),
    content: z.string().optional().nullable().openapi({ example: 'This is the note content.' }),
    mimeType: MimeTypeSchema.openapi({ example: 'text/markdown' }),
    size: z.number().openapi({ example: 123 }),
    createdAt: z.string().datetime().openapi({ example: '2023-01-01T12:00:00Z' }),
    // updatedAt is not present in SiloContentItem and has been removed from NoteSchema.
    url: z.string().url().optional().nullable().openapi({ description: 'URL for large content' }),
    customMetadata: z
      .record(z.string(), z.any())
      .optional()
      .nullable()
      .openapi({ description: 'Custom metadata' }),
  })
  .openapi('Note');

const IngestNoteBodyAPISchema = z
  .object({
    title: z.string().optional().nullable().openapi({ example: 'New Note from API' }),
    content: z.string().openapi({ example: 'Content for the new note.' }), // For notes API, content is string
    category: ContentCategoryEnum.optional().openapi({
      example: 'note',
      description: "Defaults to 'note' if not provided",
    }),
    mimeType: MimeTypeSchema.optional().openapi({
      example: 'text/markdown',
      description: "Defaults to 'text/markdown' if not provided",
    }),
  })
  .openapi('IngestNoteBodyAPISchema');

const ListNotesQuerySchema = z.object({
  limit: z.coerce.number().int().positive().optional().default(50).openapi({ example: 50 }),
  offset: z.coerce.number().int().min(0).optional().default(0).openapi({ example: 0 }),
  category: ContentCategoryEnum.optional().openapi({ example: 'note' }),
});

const DeleteSuccessResponseSchema = z
  .object({
    success: z.literal(true).openapi({ example: true }),
    message: z.string().openapi({ example: 'Note deleted successfully' }),
  })
  .openapi('DeleteSuccessResponse');

// --- Note Route Definitions ---
const ingestNoteRoute = createRoute({
  method: 'post',
  path: '/',
  summary: 'Ingest a new note',
  security: [{ BearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: IngestNoteBodyAPISchema } }, required: true },
  },
  responses: {
    201: { description: 'Note ingested.', content: { 'application/json': { schema: NoteSchema } } }, // Returns the full Note
    400: {
      description: 'Bad request.',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: {
      description: 'Unauthorized.',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    500: {
      description: 'Internal server error.',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
  tags: ['Notes'],
});

const listNotesRoute = createRoute({
  method: 'get',
  path: '/',
  summary: 'List notes',
  security: [{ BearerAuth: [] }],
  request: { query: ListNotesQuerySchema },
  responses: {
    200: {
      description: 'A list of notes.',
      content: { 'application/json': { schema: z.array(NoteSchema) } },
    },
    401: {
      description: 'Unauthorized.',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    500: {
      description: 'Internal server error.',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
  tags: ['Notes'],
});

const getNoteByIdRoute = createRoute({
  method: 'get',
  path: '/{id}',
  summary: 'Get a note by ID',
  security: [{ BearerAuth: [] }],
  request: { params: NoteIdParamSchema },
  responses: {
    200: {
      description: 'The requested note.',
      content: { 'application/json': { schema: NoteSchema } },
    },
    401: {
      description: 'Unauthorized.',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'Note not found.',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    500: {
      description: 'Internal server error.',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
  tags: ['Notes'],
});

const deleteNoteRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  summary: 'Delete a note',
  security: [{ BearerAuth: [] }],
  request: { params: NoteIdParamSchema },
  responses: {
    200: {
      description: 'Note deleted.',
      content: { 'application/json': { schema: DeleteSuccessResponseSchema } },
    },
    401: {
      description: 'Unauthorized.',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'Note not found.',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    500: {
      description: 'Internal server error.',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
  tags: ['Notes'],
});

// --- AI Reprocess Schemas & Routes ---
const ReprocessBodySchema = z
  .object({
    contentId: z.string().openapi({ example: 'content_abc123' }),
  })
  .openapi('ReprocessBody');

const ReprocessResponseSchema = z
  .object({
    success: z.literal(true),
    message: z.string(),
    reprocessedCount: z.number().optional(), // Changed from reprocessJobId
  })
  .openapi('ReprocessResponse');

const BulkReprocessBodySchema = z
  .object({
    contentIds: z.array(z.string()).min(1),
  })
  .openapi('BulkReprocessBody');

const BulkReprocessResponseSchema = z
  .object({
    success: z.literal(true),
    message: z.string(),
    reprocessedCount: z.number().optional(), // Changed from batchJobId
  })
  .openapi('BulkReprocessResponse');

const reprocessRoute = createRoute({
  method: 'post',
  path: '/reprocess',
  summary: 'Reprocess AI metadata',
  security: [{ BearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: ReprocessBodySchema } }, required: true },
  },
  responses: {
    202: {
      description: 'Reprocessing initiated.',
      content: { 'application/json': { schema: ReprocessResponseSchema } },
    },
    400: {
      description: 'Bad request.',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: {
      description: 'Unauthorized.',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'Content not found.',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    500: {
      description: 'Internal server error.',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
  tags: ['AI'],
});

const bulkReprocessRoute = createRoute({
  method: 'post',
  path: '/bulk-reprocess',
  summary: 'Bulk reprocess AI metadata',
  security: [{ BearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: BulkReprocessBodySchema } }, required: true },
  },
  responses: {
    202: {
      description: 'Bulk reprocessing initiated.',
      content: { 'application/json': { schema: BulkReprocessResponseSchema } },
    },
    400: {
      description: 'Bad request.',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: {
      description: 'Unauthorized.',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    500: {
      description: 'Internal server error.',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
  tags: ['AI'],
});

// Helper to transform SiloContentItem to NoteSchema compatible object
function transformSiloItemToNote(item: SiloContentItem): z.infer<typeof NoteSchema> {
  return {
    id: item.id,
    userId: item.userId,
    category: item.category,
    title: item.title ?? null,
    content: item.body ?? null,
    mimeType: item.mimeType,
    size: item.size,
    createdAt: new Date(item.createdAt * 1000).toISOString(),
    // No updatedAt in SiloContentItem
    url: item.url ?? null,
    customMetadata: item.customMetadata ?? null,
  };
}

export class SiloController {
  private getSiloServiceClient(env: AppEnv['Bindings']) {
    // Corrected: Accepts env
    return createServiceFactory().getSiloService(env);
  }

  ingest = async (
    c: Context<AppEnv & { Variables: { auth: AuthContext } }>,
    body: z.infer<typeof IngestNoteBodyAPISchema>,
  ): Promise<RouteConfigToTypedResponse<typeof ingestNoteRoute>> => {
    const userId = c.get('auth')?.userId;
    logger.info({ userId, title: body.title }, 'Ingest note request');
    try {
      const siloServiceClient = this.getSiloServiceClient(c.env); // Corrected: Pass c.env
      const putInput: SiloSimplePutInput = {
        content: body.content,
        userId: userId,
        category: body.category || 'note',
        mimeType: body.mimeType || 'text/markdown',
        metadata: body.title ? { title: body.title } : {},
      };
      const uploadResponse = await siloServiceClient.uploadSingle(putInput);

      const newNoteItem = await siloServiceClient.get(uploadResponse.id, userId);
      if (!newNoteItem) {
        logger.error({ noteId: uploadResponse.id, userId }, 'Failed to fetch newly ingested note');
        return c.json(
          {
            success: false as const,
            error: {
              code: 'INTERNAL_SERVER_ERROR',
              message: 'Failed to retrieve note after ingest',
            },
          },
          500,
        );
      }
      const responseNote = transformSiloItemToNote(newNoteItem);
      return c.json(responseNote, 201);
    } catch (error: any) {
      logger.error({ error: error.message, stack: error.stack, userId }, 'Ingest note failed');
      return c.json(
        {
          success: false as const,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: String(error.message) || 'Failed to ingest note',
          },
        },
        500,
      );
    }
  };

  listNotes = async (
    c: Context<AppEnv & { Variables: { auth: AuthContext } }>,
    query: z.infer<typeof ListNotesQuerySchema>,
  ): Promise<RouteConfigToTypedResponse<typeof listNotesRoute>> => {
    const userId = c.get('auth')?.userId;
    logger.info({ userId, query }, 'List notes request');
    try {
      const siloServiceClient = this.getSiloServiceClient(c.env); // Corrected: Pass c.env
      const batchInput: SiloBatchGetInput = {
        userId: userId,
        category: query.category || 'note',
        limit: query.limit,
        offset: query.offset,
      };
      const batchResult: SiloContentBatch = await siloServiceClient.batchGet(batchInput);
      const responseNotes = batchResult.items.map(transformSiloItemToNote);
      return c.json(responseNotes, 200);
    } catch (error: any) {
      logger.error({ error: error.message, stack: error.stack, userId }, 'List notes failed');
      return c.json(
        {
          success: false as const,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: String(error.message) || 'Failed to list notes',
          },
        },
        500,
      );
    }
  };

  get = async (
    c: Context<AppEnv & { Variables: { auth: AuthContext } }>,
    params: z.infer<typeof NoteIdParamSchema>,
  ): Promise<RouteConfigToTypedResponse<typeof getNoteByIdRoute>> => {
    const { id } = params;
    const userId = c.get('auth')?.userId;
    logger.info({ noteId: id, userId }, 'Get note by ID request');
    try {
      const siloServiceClient = this.getSiloServiceClient(c.env); // Corrected: Pass c.env
      const noteItem = await siloServiceClient.get(id, userId);
      if (!noteItem) {
        return c.json(
          { success: false as const, error: { code: 'NOT_FOUND', message: 'Note not found' } },
          404,
        );
      }
      const responseNote = transformSiloItemToNote(noteItem);
      return c.json(responseNote, 200);
    } catch (error: any) {
      logger.error(
        { noteId: id, error: error.message, stack: error.stack, userId },
        'Get note by ID failed',
      );
      if (
        error.message?.includes('not found') ||
        error.code === 'NOT_FOUND' ||
        error.name === 'NotFoundError'
      ) {
        return c.json(
          { success: false as const, error: { code: 'NOT_FOUND', message: 'Note not found' } },
          404,
        );
      }
      return c.json(
        {
          success: false as const,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: String(error.message) || 'Failed to get note',
          },
        },
        500,
      );
    }
  };

  // updateNote method is omitted.

  removeNote = async (
    c: Context<AppEnv & { Variables: { auth: AuthContext } }>,
    params: z.infer<typeof NoteIdParamSchema>,
  ): Promise<RouteConfigToTypedResponse<typeof deleteNoteRoute>> => {
    const { id } = params;
    const userId = c.get('auth')?.userId;
    logger.info({ noteId: id, userId }, 'Delete note request');
    try {
      const siloServiceClient = this.getSiloServiceClient(c.env); // Corrected: Pass c.env
      const deleteInput: SiloDeleteInput = { id, userId };
      const deleteResponse = await siloServiceClient.delete(deleteInput);
      if (deleteResponse.success) {
        return c.json({ success: true, message: 'Note deleted successfully' }, 200);
      } else {
        logger.warn(
          { noteId: id, userId, deleteResponse },
          'Delete operation reported not successful by service.',
        );
        return c.json(
          {
            success: false as const,
            error: { code: 'NOT_FOUND', message: 'Note not found or delete failed' },
          },
          404,
        );
      }
    } catch (error: any) {
      logger.error(
        { noteId: id, error: error.message, stack: error.stack, userId },
        'Delete note failed',
      );
      if (
        error.message?.includes('not found') ||
        error.code === 'NOT_FOUND' ||
        error.name === 'NotFoundError'
      ) {
        return c.json(
          { success: false as const, error: { code: 'NOT_FOUND', message: 'Note not found' } },
          404,
        );
      }
      return c.json(
        {
          success: false as const,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: String(error.message) || 'Failed to delete note',
          },
        },
        500,
      );
    }
  };

  reprocess = async (
    c: Context<AppEnv & { Variables: { auth: AuthContext } }>,
    body: z.infer<typeof ReprocessBodySchema>,
  ): Promise<RouteConfigToTypedResponse<typeof reprocessRoute>> => {
    const { contentId } = body;
    const userId = c.get('auth')?.userId;
    logger.info({ contentId, userId }, 'Reprocess content request');
    try {
      const siloServiceClient = this.getSiloServiceClient(c.env); // Corrected: Pass c.env
      const result = await siloServiceClient.reprocessContent([contentId]);

      return c.json(
        {
          success: true,
          message: `Reprocessing initiated for ${result.reprocessed} item(s).`,
          reprocessedCount: result.reprocessed,
        },
        202,
      );
    } catch (error: any) {
      logger.error(
        { contentId, error: error.message, stack: error.stack, userId },
        'Reprocess content failed',
      );
      if (
        error.message?.includes('not found') ||
        error.code === 'NOT_FOUND' ||
        error.name === 'NotFoundError'
      ) {
        return c.json(
          {
            success: false as const,
            error: { code: 'NOT_FOUND', message: 'Content to reprocess not found' },
          },
          404,
        );
      }
      return c.json(
        {
          success: false as const,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: String(error.message) || 'Failed to reprocess content',
          },
        },
        500,
      );
    }
  };

  bulkReprocess = async (
    c: Context<AppEnv & { Variables: { auth: AuthContext } }>,
    body: z.infer<typeof BulkReprocessBodySchema>,
  ): Promise<RouteConfigToTypedResponse<typeof bulkReprocessRoute>> => {
    const { contentIds } = body;
    const userId = c.get('auth')?.userId;
    logger.info({ contentIdsCount: contentIds.length, userId }, 'Bulk reprocess content request');
    try {
      const siloServiceClient = this.getSiloServiceClient(c.env); // Corrected: Pass c.env
      const result = await siloServiceClient.reprocessContent(contentIds);

      return c.json(
        {
          success: true,
          message: `Bulk reprocessing initiated for ${result.reprocessed} item(s).`,
          reprocessedCount: result.reprocessed,
        },
        202,
      );
    } catch (error: any) {
      logger.error(
        { contentIdsCount: contentIds.length, error: error.message, stack: error.stack, userId },
        'Bulk reprocess content failed',
      );
      return c.json(
        {
          success: false as const,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: String(error.message) || 'Failed to bulk reprocess content',
          },
        },
        500,
      );
    }
  };
}

export function createSiloController(): SiloController {
  return new SiloController();
}

export function buildNotesRouter(): OpenAPIHono<AppEnv & { Variables: { auth: AuthContext } }> {
  const siloController = createSiloController();
  const notesRouter = new OpenAPIHono<AppEnv & { Variables: { auth: AuthContext } }>();

  notesRouter.use('*', authenticationMiddleware);

  notesRouter.openapi(ingestNoteRoute, c => siloController.ingest(c, c.req.valid('json')));
  notesRouter.openapi(listNotesRoute, c => siloController.listNotes(c, c.req.valid('query')));
  notesRouter.openapi(getNoteByIdRoute, c => siloController.get(c, c.req.valid('param')));
  // updateNoteRoute is omitted
  notesRouter.openapi(deleteNoteRoute, c => siloController.removeNote(c, c.req.valid('param')));

  return notesRouter;
}

export function buildAiRouter(): OpenAPIHono<AppEnv & { Variables: { auth: AuthContext } }> {
  const siloController = createSiloController();
  const aiRouter = new OpenAPIHono<AppEnv & { Variables: { auth: AuthContext } }>();

  aiRouter.use('*', authenticationMiddleware);

  aiRouter.openapi(reprocessRoute, c => siloController.reprocess(c, c.req.valid('json')));
  aiRouter.openapi(bulkReprocessRoute, c => siloController.bulkReprocess(c, c.req.valid('json')));

  return aiRouter;
}
