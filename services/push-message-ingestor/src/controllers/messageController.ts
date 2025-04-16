/**
 * Message controller for handling message-related API endpoints
 */
import { AppError, createValidationError } from '../middleware/errorMiddleware';
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
   * @returns A plain object that will be wrapped in a standardized response
   */
  async publishTelegramMessages(body: TelegramMessageBatch): Promise<{ message: string; count: number }> {
    // Handle empty message array gracefully
    if (!body.messages || body.messages.length === 0) {
      return {
        message: "Successfully published 0 messages to the queue",
        count: 0
      };
    }

    // Publish the messages
    await this.messageService.publishTelegramMessages(body);

    // Return success response as a plain object
    return {
      message: `Successfully published ${body.messages.length} messages to the queue`,
      count: body.messages.length
    };
  }
}
