import { Context } from 'hono';
import { getLogger } from '@dome/logging';
import { ChatClient, chatRequestSchema } from '@dome/chat/client';


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
        return c.json(
          {
            success: false,
            error: {
              code: 'MISSING_USER_ID',
              message: 'User ID is required',
            },
          },
          401,
        );
      }

      // Parse request body
      const requestData = chatRequestSchema.parse(await c.req.json());

      try {

        // Log the request data before validation
        this.logger.debug(
          {
            requestData: JSON.stringify(requestData, null, 2),
          },
          'Request data before validation'
        );

        // Validate using Zod schema
        const request = chatRequestSchema.parse(requestData);

        this.logger.info(
          {
            userId,
            request,
            messageCount: request.initialState.messages.length,
          },
          'Processing validated chat request'
        );

        // Process request
        if (request.stream) {
          // Stream response
          const response = await this.chatService.streamResponse(request);
          return response;
        } else {
          // Generate response
          const response = await this.chatService.generateResponse(request);

          return c.json({
            success: true,
            response,
          });
        }
      } catch (validationError) {
        // Handle validation errors
        this.logger.warn(
          {
            err: validationError,
            userId
          },
          'Invalid chat request format'
        );

        return c.json(
          {
            success: false,
            error: {
              code: 'INVALID_REQUEST',
              message: validationError instanceof Error
                ? validationError.message
                : 'Invalid request format',
            },
          },
          400
        );
      }
    } catch (error) {
      this.logger.error({ err: error }, 'Unexpected error in chat controller');

      return c.json(
        {
          success: false,
          error: {
            code: 'INTERNAL_ERROR',
            message: 'An unexpected error occurred',
          },
        },
        500,
      );
    }
  }
}

