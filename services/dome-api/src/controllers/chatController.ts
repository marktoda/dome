import { Context } from 'hono';
import { getLogger } from '@dome/logging';
import { ChatClient, chatRequestSchema } from '@dome/chat/client';
import { z } from 'zod';
import {
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
  internalErrorResponse,
} from '../utils/responseHelpers';

/**
 * Controller for chat endpoints
 */
export class ChatController {
  private logger = getLogger().child({ controller: 'ChatController' });

  /**
   * Create a new chat controller
   * @param chatService Chat service instance
   */
  constructor(private chatService: ChatClient) { }

  /**
   * Handle chat requests
   * @param c Hono context
   * @returns Response with chat result
   */
  async chat(c: Context): Promise<Response> {
    try {
      // Get user ID from header
      const userId = c.req.header('x-user-id');
      if (!userId) {
        this.logger.warn('Missing user ID in request');
        return unauthorizedResponse(c, 'User ID is required');
      }

      // Parse request body
      const requestData = chatRequestSchema.parse(await c.req.json());

      try {
        // Log the request data before validation
        this.logger.debug(
          {
            requestData: JSON.stringify(requestData, null, 2),
          },
          'Request data before validation',
        );

        // Validate using Zod schema
        const request = chatRequestSchema.parse(requestData);

        this.logger.info(
          {
            userId,
            request,
            messageCount: request.messages.length,
          },
          'Processing validated chat request',
        );

        // Process request - temporarily use non-streaming only
        // This is a workaround until streaming issues are fixed
        const response = await this.chatService.generateDirectResponse(request);
        this.logger.info(
          {
            userId,
            responseLength: response.response.length,
            hasSourceInfo: response.sources && response.sources.length > 0,
            response,
          },
          'Generated non-streaming chat response'
        );

        return successResponse(c, { response });
      } catch (validationError) {
        // Handle validation errors
        this.logger.warn(
          {
            err: validationError,
            userId,
          },
          'Invalid chat request format',
        );

        return validationErrorResponse(
          c,
          validationError instanceof Error ? validationError.message : 'Invalid request format',
        );
      }
    } catch (error) {
      this.logger.error({ err: error }, 'Unexpected error in chat controller');
      return internalErrorResponse(c);
    }
  }
}
