import { z, type ZodTypeAny } from 'zod';
import {
  serializeQueueMessage,
  parseMessageBatch,
  toRawMessageBatch,
  RawMessageBatch,
  ParsedMessageBatch,
  MessageBatch,
} from './index.js';

/** Minimal subset of the Cloudflare Queue interface used by this helper */
export interface Queue {
  send(body: string | ArrayBuffer): Promise<void>;
  sendBatch(messages: Iterable<{ body: string | ArrayBuffer }>): Promise<void>;
}

/**
 * Abstract base class for type-safe queue wrappers.
 * Subclasses must provide a Zod schema to validate and serialize messages.
 * 
 * @example
 * ```ts
 * export class ContentQueue extends AbstractQueue<typeof ContentMessageSchema> {
 *   static override schema = ContentMessageSchema;
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
type MessageOf<S extends ZodTypeAny> = z.infer<S>;

export abstract class AbstractQueue<S extends ZodTypeAny> {
  /**
   * The Zod schema used to validate and serialize messages.
   * Subclasses must provide this as a static field.
   */
  static schema: ZodTypeAny;

  /**
   * Create a new queue wrapper for the given Cloudflare Queue binding.
   * @param queue The Cloudflare Queue binding
   */
  protected readonly schema: S;

  constructor(protected readonly queue: Queue) {
    // Bridge the static schema to the instance for convenience
    this.schema = (this.constructor as typeof AbstractQueue & { schema: S }).schema as S;
  }

  /**
   * Send a validated message to the queue.
   * @param message The message to send
   */
  async send(message: MessageOf<S>): Promise<void> {
    const serialized = serializeQueueMessage(this.schema, message);
    await this.queue.send(serialized);
  }

  /**
   * Send multiple messages to the queue in sequence.
   * @param messages The messages to send
   */
  async sendBatch(messages: ReadonlyArray<MessageOf<S>>): Promise<void> {
    const payload = messages.map(m => ({
      body: serializeQueueMessage(this.schema, m),
    }));
    await this.queue.sendBatch(payload);
  }

  /**
   * Parse a message batch from a queue consumer.
   * Static method that can be called without instantiating the queue.
   * 
   * @param batch The raw message batch from Cloudflare
   * @returns The parsed messages with proper types
   */
  static parseBatch<S extends ZodTypeAny>(
    this: { schema: S },
    batch: MessageBatch<unknown>
  ): ParsedMessageBatch<MessageOf<S>> {
    const raw = toRawMessageBatch(batch);
    return parseMessageBatch(this.schema, raw as RawMessageBatch);
  }
}
