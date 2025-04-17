/**
 * Message service for handling message operations
 */
import type { PlatformMessage } from '../models/message';
import type { MessageData } from '@dome/common';
import { QueueError, BatchValidationError } from '@dome/common';

/**
 * Service for handling message operations
 */
export class MessageService {
  private queueBinding: Queue<MessageData>;

  /**
   * Creates a new MessageService
   * @param queueBinding The queue binding to use for publishing messages
   */
  constructor(queueBinding: Queue<MessageData>) {
    this.queueBinding = queueBinding;
  }

  /**
   * Publishes a single message to the queue
   * @param message The message to publish
   * @returns A promise that resolves when the message is published
   * @throws QueueError if there's an issue with the queue
   */
  async publishMessage(message: PlatformMessage): Promise<number> {
    return await this.publishMessages([message]);
  }

  /**
   * Publishes a batch of messages to the queue
   * @param messages The messages to publish
   * @returns A promise that resolves when all messages are published
   * @throws QueueError if there's an issue with the queue
   * @throws BatchValidationError if the batch is invalid
   */
  async publishMessages(messages: PlatformMessage[]): Promise<number> {
    if (messages.length === 0) {
      throw new BatchValidationError('Cannot publish empty message batch');
    }

    try {
      await this.queueBinding.sendBatch(
        messages.map(message => ({ body: message.toMessageData() })),
      );
      return messages.length;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new QueueError(`Failed to publish message batch to queue: ${errorMessage}`, {
        messageCount: messages.length,
        platforms: [...new Set(messages.map(m => m.platform))],
      });
    }
  }
}
