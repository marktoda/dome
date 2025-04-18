import { Event } from '../types/events';
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
export declare class QueueService {
  private queueBinding;
  private maxRetries;
  /**
   * Create a new QueueService instance
   * @param options Queue service options
   */
  constructor(options: QueueServiceOptions);
  /**
   * Publish an event to the queue
   * @param event The event to publish
   * @returns Promise that resolves when the event is published
   */
  publishEvent(event: Event): Promise<void>;
  /**
   * Publish multiple events to the queue
   * @param events Array of events to publish
   * @returns Promise that resolves when all events are published
   */
  publishEvents(events: Event[]): Promise<void>;
  /**
   * Process a message from the queue
   * @param message The queue message to process
   * @param handler The handler function to process the event
   */
  processMessage(message: MessageBatch, handler: (event: Event) => Promise<void>): Promise<void>;
}
