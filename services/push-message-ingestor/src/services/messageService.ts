/**
 * Message service for handling message operations
 */
import { BaseMessage, TelegramMessageBatch } from '../models/message';
import {
  QueueError,
  MessageProcessingError,
  BatchValidationError
} from '../errors';

/**
 * Service for handling message operations
 */
export class MessageService {
  private queueBinding: Queue<BaseMessage>;

  /**
   * Creates a new MessageService
   * @param queueBinding The queue binding to use for publishing messages
   */
  constructor(queueBinding: Queue<BaseMessage>) {
    this.queueBinding = queueBinding;
  }

  /**
   * Publishes a single message to the queue
   * @param message The message to publish
   * @returns A promise that resolves when the message is published
   * @throws QueueError if there's an issue with the queue
   */
  async publishMessage(message: BaseMessage): Promise<void> {
    try {
      await this.queueBinding.send(message);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new QueueError(`Failed to publish message to queue: ${errorMessage}`, {
        messageId: message.id,
        platform: message.platform
      });
    }
  }

  /**
   * Publishes a batch of messages to the queue
   * @param messages The messages to publish
   * @returns A promise that resolves when all messages are published
   * @throws QueueError if there's an issue with the queue
   * @throws BatchValidationError if the batch is invalid
   */
  async publishMessages(messages: BaseMessage[]): Promise<void> {
    if (!messages || messages.length === 0) {
      throw new BatchValidationError('Cannot publish empty message batch');
    }

    try {
      await this.queueBinding.sendBatch(messages.map(message => ({ body: message })));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new QueueError(`Failed to publish message batch to queue: ${errorMessage}`, {
        messageCount: messages.length,
        platforms: [...new Set(messages.map(m => m.platform))]
      });
    }
  }

  /**
   * Publishes a batch of Telegram messages to the queue
   * @param batch The batch of Telegram messages to publish
   * @returns The number of messages published
   * @throws BatchValidationError if the batch is invalid
   * @throws MessageProcessingError if there's an issue processing the messages
   * @throws QueueError if there's an issue with the queue
   */
  async publishTelegramMessages(batch: TelegramMessageBatch): Promise<number> {
    // Publish the messages
    await this.publishMessages(batch.messages);
    return batch.messages.length;
  }
}

