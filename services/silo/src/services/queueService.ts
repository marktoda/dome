import { getLogger, metrics } from '@dome/logging';

/**
 * QueueService - A wrapper around Queue operations
 * This service encapsulates all interactions with Cloudflare Queues
 */
export class QueueService {
  constructor(private env: any) { }

  /**
   * Send a message to the NEW_CONTENT queue
   * @param message The message to send
   */
  async sendNewContentMessage(message: any) {
    const startTime = Date.now();

    try {
      await this.env.NEW_CONTENT.send(message);

      metrics.timing('silo.queue.send.latency_ms', Date.now() - startTime);
      getLogger().info({ message }, 'Message sent to NEW_CONTENT queue');

      return true;
    } catch (error) {
      metrics.increment('silo.queue.errors', 1, { operation: 'send' });
      getLogger().error({ error, message }, 'Error sending message to NEW_CONTENT queue');
      throw error;
    }
  }
}

export function createQueueService(env: any): QueueService {
  return new QueueService(env);
}
