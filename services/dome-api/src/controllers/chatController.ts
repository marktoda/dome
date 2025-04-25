import { Context } from 'hono';
import { getLogger } from '@dome/logging';
import { ChatOrchestratorClient } from '@dome/chat-orchestrator/client';

/**
 * Controller for chat endpoints
 */
export class ChatController {
  private logger = getLogger().child({ controller: 'ChatController' });

  /**
   * Create a new chat controller
   * @param chatService Chat service instance
   */
  constructor(private chatService: ChatOrchestratorClient) { }

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
        return c.json({
          success: false,
          error: {
            code: 'MISSING_USER_ID',
            message: 'User ID is required'
          }
        }, 401);
      }

      // Parse request body
      const body = await c.req.json();

      // Validate messages
      if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
        this.logger.warn({ userId }, 'Missing or invalid messages in request');
        return c.json({
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'Messages are required and must be an array'
          }
        }, 400);
      }

      // Check if at least one user message is present
      const hasUserMessage = body.messages.some((msg: any) => msg.role === 'user');
      if (!hasUserMessage) {
        this.logger.warn({ userId }, 'No user message in request');
        return c.json({
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'At least one user message is required'
          }
        }, 400);
      }

      // Add user ID to request
      const request = {
        ...body,
        userId,
      };

      this.logger.info(
        {
          userId,
          stream: request.stream,
        },
        'Processing chat request'
      );

      try {
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
      } catch (error) {
        this.logger.error(
          {
            err: error,
            userId,
            stream: request.stream,
          },
          'Error processing chat request'
        );

        return c.json({
          success: false,
          error: {
            code: 'CHAT_ERROR',
            message: error instanceof Error ? error.message : 'Unknown error',
          }
        }, 200);
      }
    } catch (error) {
      this.logger.error({ err: error }, 'Unexpected error in chat controller');

      return c.json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred',
        }
      }, 500);
    }
  }
}
