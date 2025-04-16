/**
 * Message service for handling message operations
 */
import { BaseMessage, TelegramMessageBatch } from '../models/message';

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
   */
  async publishMessage(message: BaseMessage): Promise<void> {
    await this.queueBinding.send(message);
  }

  /**
   * Publishes a batch of messages to the queue
   * @param messages The messages to publish
   * @returns A promise that resolves when all messages are published
   */
  async publishMessages(messages: BaseMessage[]): Promise<void> {
    await this.queueBinding.sendBatch(messages.map(message => ({ body: message })));
  }

  /**
   * Publishes a batch of Telegram messages to the queue
   * @param batch The batch of Telegram messages to publish
   * @returns A result object with success status and optional error message
   */
  async publishTelegramMessages(batch: TelegramMessageBatch): Promise<number> {
    // Handle empty batch gracefully
    if (!batch.messages || batch.messages.length === 0) {
      return 0;
    }

    // Publish the messages
    await this.publishMessages(batch.messages);
    return batch.messages.length;
  }
}

