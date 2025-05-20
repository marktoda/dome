import { z, ZodSchema } from 'zod';
import {
  serializeQueueMessage,
  parseMessageBatch,
  toRawMessageBatch,
  RawMessageBatch,
  ParsedMessageBatch,
  MessageBatch,
} from './index.js';

/**
 * Abstract base class for type-safe queue wrappers.
 * Subclasses must provide a Zod schema to validate and serialize messages.
 * 
 * @example
 * ```ts
 * export class ContentQueue extends AbstractQueue<ContentMessage, typeof ContentMessageSchema> {
 *   protected readonly schema = ContentMessageSchema;
 * }
 * 
 * // Producer
 * const queue = new ContentQueue(env.CONTENT_QUEUE);
 * await queue.send({ id: "123", type: "content", ... });
 * 
 * // Consumer
 * const messages = ContentQueue.parseBatch(batch);
 * ```
 */
export abstract class AbstractQueue<T, S extends ZodSchema<T>> {
  /**
   * The Zod schema used to validate and serialize messages.
   * Subclasses must provide this as a static field.
   */
  public static schema: ZodSchema<any>;

  /**
   * Create a new queue wrapper for the given Cloudflare Queue binding.
   * @param queue The Cloudflare Queue binding
   */
  constructor(protected readonly queue: { send(body: string | ArrayBuffer): Promise<void> }) {}

  /**
   * Send a validated message to the queue.
   * @param message The message to send
   */
  async send(message: T): Promise<void> {
    const cls = this.constructor as typeof AbstractQueue & { schema: S };
    const serialized = serializeQueueMessage(cls.schema as S, message);
    await this.queue.send(serialized);
  }

  /**
   * Send multiple messages to the queue in sequence.
   * @param messages The messages to send
   */
  async sendBatch(messages: Iterable<T>): Promise<void> {
    for (const message of messages) {
      await this.send(message);
    }
  }

  /**
   * Parse a message batch from a queue consumer.
   * Static method that can be called without instantiating the queue.
   * 
   * @param batch The raw message batch from Cloudflare
   * @returns The parsed messages with proper types
   */
  static parseBatch<T, S extends ZodSchema<T>>(
    this: { new (...args: any[]): AbstractQueue<T, S> } & { schema: S },
    batch: MessageBatch<unknown>
  ): ParsedMessageBatch<T> {
    const raw = toRawMessageBatch(batch);
    return parseMessageBatch(this.schema as S, raw as RawMessageBatch);
  }
} 