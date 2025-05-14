import { Context } from 'hono';
import { getIdentity, getLogger, ServiceError } from '@dome/common';
import { ChatClient, chatRequestSchema, ChatRequest } from '@dome/chat/client'; // Assuming ChatRequest is the type for chatRequestSchema
import { z } from 'zod';
import { createRoute, OpenAPIHono, RouteConfigToTypedResponse } from '@hono/zod-openapi';
import { AppEnv, Bindings } from '../types';
import { AuthContext, authenticationMiddleware } from '../middleware/authenticationMiddleware';
import { createServiceFactory } from '../services/serviceFactory';
import {
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
  internalErrorResponse,
} from '../utils/responseHelpers';

// --- OpenAPI Schemas ---

// Placeholder for Source if it's part of the response
const SourceSchema = z
  .object({
    id: z.string().openapi({ example: 'doc_123' }),
    type: z.string().openapi({ example: 'document' }),
    title: z.string().optional().openapi({ example: 'Source Document Title' }),
    url: z.string().url().optional().openapi({ example: 'https://example.com/doc_123' }),
  })
  .openapi('ChatSource');

const ChatSuccessDataSchema = z
  .object({
    response: z.string().openapi({ example: "This is the chat bot's answer." }),
    sources: z
      .array(SourceSchema)
      .optional()
      .openapi({ description: 'Supporting sources for the response.' }),
  })
  .openapi('ChatSuccessData');

const ChatOpenAPISuccessResponseSchema = z
  .object({
    success: z.literal(true).openapi({ example: true }),
    data: ChatSuccessDataSchema,
  })
  .openapi('ChatSuccessResponse');

const ChatErrorDetailSchema = z.object({
  code: z.string().openapi({ example: 'INVALID_REQUEST' }),
  message: z.string().openapi({ example: 'Invalid request format' }),
});
const ChatOpenAPIErrorResponseSchema = z
  .object({
    success: z.literal(false).openapi({ example: false }),
    error: ChatErrorDetailSchema,
  })
  .openapi('ChatErrorResponse');

// --- Route Definition ---
const chatRoute = createRoute({
  method: 'post',
  path: '/', // Relative to where buildChatRouter is mounted (e.g., /chat)
  summary: 'Send a chat message',
  description: 'Processes a user chat message and returns a response.',
  security: [{ BearerAuth: [] }],
  request: {
    body: {
      content: {
        // Use the imported chatRequestSchema directly
        'application/json': { schema: chatRequestSchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Successful chat response.',
      content: { 'application/json': { schema: ChatOpenAPISuccessResponseSchema } },
    },
    400: {
      description: 'Bad Request (e.g., validation error).',
      content: { 'application/json': { schema: ChatOpenAPIErrorResponseSchema } },
    },
    401: {
      description: 'Unauthorized.',
      content: { 'application/json': { schema: ChatOpenAPIErrorResponseSchema } },
    },
    500: {
      description: 'Internal Server Error.',
      content: { 'application/json': { schema: ChatOpenAPIErrorResponseSchema } },
    },
  },
  tags: ['Chat'],
});

/**
 * Controller for chat endpoints
 */
export class ChatController {
  private logger = getLogger().child({ controller: 'ChatController' });

  // constructor(private chatService: ChatClient) {} // Old constructor

  constructor() {
    // Parameterless constructor
  }

  private getChatService(env: Bindings): ChatClient {
    const serviceFactory = createServiceFactory();
    return serviceFactory.getChatService(env);
  }

  /**
   * Handle chat requests
   * @param c Hono context
   * @param body Validated request body
   * @returns Response with chat result
   */
  async chat(
    c: Context<AppEnv & { Variables: { auth: AuthContext } }>,
    body: z.infer<typeof chatRequestSchema>, // Use inferred type from chatRequestSchema
  ): Promise<RouteConfigToTypedResponse<typeof chatRoute>> {
    let userId: string | undefined; // Declare userId here to be accessible in catch
    try {
      userId = c.get('auth').userId; // Initialize userId
      const requestData = body; // Already validated

      // The original code had a nested try-catch for validation,
      // but with OpenAPI, Hono typically handles request body validation before this handler.
      // If `c.req.valid('json')` or similar is used in the router, `body` is already parsed & validated.

      this.logger.info(
        {
          userId,
          request: requestData, // Use the validated body
          messageCount: requestData.messages.length,
        },
        'Processing validated chat request',
      );

      const chatService = this.getChatService(c.env);
      const serviceResponse = await chatService.generateDirectResponse(requestData);
      // serviceResponse is expected to be like: { response: string, sources?: Source[] }

      this.logger.info(
        {
          userId,
          responseLength: serviceResponse.response.length,
          hasSourceInfo: serviceResponse.sources && serviceResponse.sources.length > 0,
          // response: serviceResponse, // Avoid logging potentially large full response object
        },
        'Generated non-streaming chat response',
      );

      // Align with ChatOpenAPISuccessResponseSchema
      return c.json(
        {
          success: true,
          data: {
            response: serviceResponse.response,
            sources: serviceResponse.sources as any, // Cast sources if their schema isn't strictly matched yet
          },
        },
        200,
      );
    } catch (error: any) {
      this.logger.error({ err: error, userId }, 'Error in chat method');
      if (error instanceof z.ZodError) {
        // Should be caught by middleware if using c.req.valid('json')
        return c.json(
          {
            success: false,
            error: { code: 'VALIDATION_ERROR', message: error.message },
          },
          400,
        );
      }
      if (error instanceof ServiceError) {
        const status = error.status || 500;
        const code = error.code || 'SERVICE_ERROR';
        if (status === 401)
          return c.json({ success: false, error: { code, message: error.message } }, 401);
        if (status === 400)
          return c.json({ success: false, error: { code, message: error.message } }, 400);
        return c.json({ success: false, error: { code, message: error.message } }, 500);
      }
      return c.json(
        {
          success: false,
          error: {
            code: 'INTERNAL_ERROR',
            message: error.message || 'An unexpected error occurred',
          },
        },
        500,
      );
    }
  }
}

// --- Router Builder ---
export function buildChatRouter(): OpenAPIHono<AppEnv & { Variables: { auth: AuthContext } }> {
  const router = new OpenAPIHono<AppEnv & { Variables: { auth: AuthContext } }>();
  const chatController = new ChatController();

  // Apply authentication middleware
  // Note: authenticationMiddleware itself might need to be adapted if it's not already
  // compatible with OpenAPIHono context or if it relies on c.get('auth') being set by a prior global middleware.
  // For now, assuming it works or will be adjusted.
  router.use('/', authenticationMiddleware);

  router.openapi(chatRoute, c => {
    const validatedBody = c.req.valid('json'); // Hono/Zod OpenAPI handles validation
    return chatController.chat(c, validatedBody);
  });

  return router;
}
// Removed duplicated old chat method logic from here down.
