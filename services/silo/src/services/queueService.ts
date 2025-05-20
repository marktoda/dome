import { getLogger, logError, metrics, NewContentMessage } from '@dome/common';
import { NewContentQueue } from '../queues/NewContentQueue';

/**
 * QueueService - A wrapper around Queue operations
 * This service encapsulates all interactions with Cloudflare Queues
 */
export class QueueService {
  private readonly constellation: NewContentQueue;
  private readonly ai: NewContentQueue;

  constructor(private env: any) {
    this.constellation = new NewContentQueue(env.NEW_CONTENT_CONSTELLATION);
    this.ai = new NewContentQueue(env.NEW_CONTENT_AI);
  }

  /**
   * Send a message to the NEW_CONTENT queue
   * @param message The message to send
   */
  async sendNewContentMessage(message: NewContentMessage) {
    const startTime = Date.now();

    try {
      await this.constellation.send(message);
      await this.ai.send(message);

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
