/**
 * Message controller for handling message-related API endpoints
 */
import {
  ValidationError,
  BatchValidationError,
  QueueError,
  MessageProcessingError
} from '../errors';
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
   * @throws ValidationError if the request is invalid
   * @throws QueueError if there's an issue with the queue
   * @throws MessageProcessingError if there's an issue processing the messages
   */
  async publishTelegramMessages(body: TelegramMessageBatch): Promise<{ message: string; count: number }> {
    try {
      // Handle empty message array gracefully
      if (body.messages.length === 0) {
        return {
          message: "Successfully published 0 messages to the queue",
          count: 0
        };
      }

      // Validate message count
      if (body.messages.length > 100) {
        throw new BatchValidationError('Batch size exceeds maximum allowed (100)', {
          providedCount: body.messages.length,
          maxAllowed: 100
        });
      }

      // Publish the messages
      const count = await this.messageService.publishTelegramMessages(body);

      // Return success response as a plain object
      return {
        message: `Successfully published ${count} messages to the queue`,
        count
      };
    } catch (error) {
      // Re-throw known errors
      if (error instanceof ValidationError ||
        error instanceof QueueError ||
        error instanceof MessageProcessingError) {
        throw error;
      }

      // Wrap unknown errors
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new MessageProcessingError(`Failed to process message batch: ${errorMessage}`);
    }
  }
}
