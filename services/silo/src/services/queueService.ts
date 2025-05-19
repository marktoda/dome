import {
  getLogger,
  logError,
  metrics,
  NewContentMessage,
  NewContentMessageSchema,
  serializeQueueMessage,
} from '@dome/common';

/**
 * QueueService - A wrapper around Queue operations
 * This service encapsulates all interactions with Cloudflare Queues
 */
export class QueueService {
  constructor(private env: any) {}

  /**
   * Send a message to the NEW_CONTENT queue
   * @param message The message to send
   */
  async sendNewContentMessage(message: NewContentMessage) {
    const startTime = Date.now();

    try {
      const serialized = serializeQueueMessage(NewContentMessageSchema, message);
      await this.env.NEW_CONTENT_CONSTELLATION.send(serialized);
      await this.env.NEW_CONTENT_AI.send(serialized);

      metrics.timing('silo.queue.send.latency_ms', Date.now() - startTime);
      getLogger().info({ message }, 'Message sent to NEW_CONTENT queue');

      return true;
    } catch (error) {
      metrics.increment('silo.queue.errors', 1, { operation: 'send' });
      logError(error, 'Error sending message to NEW_CONTENT queue', { message });
      throw error;
    }
  }
}

export function createQueueService(env: any): QueueService {
  return new QueueService(env);
}
