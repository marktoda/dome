import { z } from 'zod';
import { Event, EventSchema } from '../types/events';
import { QueueError } from '../errors/ServiceError';

/**
 * Cloudflare Queue type definitions
 */
export interface Queue {
  send: (message: string) => Promise<void>;
}

export interface QueueMessage {
  id: string;
  timestamp: number;
  body: string;
}

export interface MessageBatch {
  messages: QueueMessage[];
  ack: (messageId: string) => void;
}

/**
 * Queue service options
 */
export interface QueueServiceOptions {
  queueBinding: Queue;
  maxRetries?: number;
}

/**
 * Queue service for interacting with Cloudflare Queues
 */
export class QueueService {
  private queueBinding: Queue;
  private maxRetries: number;

  /**
   * Create a new QueueService instance
   * @param options Queue service options
   */
  constructor(options: QueueServiceOptions) {
    this.queueBinding = options.queueBinding;
    this.maxRetries = options.maxRetries || 3;
  }

  /**
   * Publish an event to the queue
   * @param event The event to publish
   * @returns Promise that resolves when the event is published
   */
  async publishEvent(event: Event): Promise<void> {
    try {
      // Validate the event against the schema
      EventSchema.parse(event);

      // Serialize the event to JSON
      const serializedEvent = JSON.stringify(event);

      // Send the event to the queue
      await this.queueBinding.send(serializedEvent);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new QueueError('Event validation failed', {
          code: 'INVALID_EVENT',
          details: error.format(),
        });
      }
      throw new QueueError('Failed to publish event to queue', {
        code: 'QUEUE_PUBLISH_ERROR',
        eventType: event.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Publish multiple events to the queue
   * @param events Array of events to publish
   * @returns Promise that resolves when all events are published
   */
  async publishEvents(events: Event[]): Promise<void> {
    try {
      // Validate all events against the schema
      events.forEach(event => EventSchema.parse(event));

      // Serialize all events to JSON
      const serializedEvents = events.map(event => JSON.stringify(event));

      // Send all events to the queue
      const promises = serializedEvents.map(event => this.queueBinding.send(event));
      await Promise.all(promises);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new QueueError('Event validation failed', {
          code: 'INVALID_EVENT',
          details: error.format(),
        });
      }
      throw new QueueError('Failed to publish events to queue', {
        code: 'QUEUE_PUBLISH_ERROR',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Process a message from the queue
   * @param message The queue message to process
   * @param handler The handler function to process the event
   */
  async processMessage(
    message: MessageBatch,
    handler: (event: Event) => Promise<void>,
  ): Promise<void> {
    // Process each message in the batch
    for (const msg of message.messages) {
      try {
        // Parse the message body as JSON
        const rawEvent = JSON.parse(msg.body);

        // Validate the event against the schema
        const event = EventSchema.parse(rawEvent);

        // Process the event with the handler
        await handler(event);

        // Acknowledge the message as processed
        message.ack(msg.id);
      } catch (error) {
        console.error('Error processing queue message:', error);

        // Parse the message body to get the event
        try {
          const rawEvent = JSON.parse(msg.body);

          // Check if we should retry the event
          if (rawEvent.attempts < this.maxRetries) {
            // Increment the retry count
            rawEvent.attempts = (rawEvent.attempts || 0) + 1;

            // Re-publish the event with incremented retry count
            await this.queueBinding.send(JSON.stringify(rawEvent));

            // Acknowledge the original message
            message.ack(msg.id);
          } else {
            // Max retries reached, acknowledge the message to remove it from the queue
            message.ack(msg.id);

            // Log the failure
            console.error(`Max retries (${this.maxRetries}) reached for event:`, rawEvent);
          }
        } catch (parseError) {
          // If we can't parse the message, just acknowledge it to remove it from the queue
          console.error('Failed to parse message body:', parseError);
          message.ack(msg.id);
        }
      }
    }
  }
}
