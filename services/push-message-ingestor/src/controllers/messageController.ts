/**
 * Message controller for handling message-related API endpoints
 */
import { Context } from 'hono';
import { ApiResponse } from '@communicator/common';
import { TelegramMessageBatch, BaseMessage } from '../models/message';
import { MessageService } from '../services/messageService';

/**
 * Controller for handling message-related API endpoints
 */
export class MessageController {
  private messageService: MessageService;

  /**
   * Creates a new MessageController
   * @param queueBinding The queue binding to use for publishing messages
   */
  constructor(queueBinding: Queue<BaseMessage>) {
    this.messageService = new MessageService(queueBinding);
  }

  /**
   * Handles the publish Telegram messages endpoint
   * @param body The validated request body
   * @returns A JSON response
   */
  async publishTelegramMessages(body: TelegramMessageBatch): Promise<Response> {
    try {
      // Handle empty message array gracefully
      if (!body.messages || body.messages.length === 0) {
        return Response.json({
          success: true,
          data: {
            message: "Successfully published 0 messages to the queue",
            count: 0
          }
        });
      }

      // Publish the messages
      const result = await this.messageService.publishTelegramMessages(body);

      if (!result.success) {
        return Response.json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: result.error || 'Invalid message batch'
          }
        }, { status: 400 });
      }

      // Return success response
      return Response.json({
        success: true,
        data: {
          message: `Successfully published ${body.messages.length} messages to the queue`,
          count: body.messages.length
        }
      });
    } catch (error) {
      // Extract error message
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      // Determine if this is a validation error or server error
      const isValidationError = errorMessage.toLowerCase().includes('required') ||
                               errorMessage.toLowerCase().includes('invalid') ||
                               errorMessage.toLowerCase().includes('undefined');
      
      return Response.json({
        success: false,
        error: {
          code: isValidationError ? 'VALIDATION_ERROR' : 'SERVER_ERROR',
          message: errorMessage
        }
      }, { status: isValidationError ? 400 : 500 });
    }
  }
}
