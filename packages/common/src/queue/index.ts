import { z, ZodSchema } from 'zod';
import { MessageProcessingError } from '../errors/ServiceError.js';

/** Raw message format coming from Cloudflare Queues */
export interface RawQueueMessage {
  id: string;
  timestamp: number;
  body: string;
}

/** Parsed message after validation */
export interface ParsedQueueMessage<T> {
  id: string;
  timestamp: number;
  body: T;
}

/** Raw batch format coming from Cloudflare */
export interface RawMessageBatch {
  queue: string;
  messages: RawQueueMessage[];
}

/** Minimal representation of the MessageBatch type from Cloudflare */
export interface MessageBatch<Body = unknown> {
  queue: string;
  messages: ReadonlyArray<{
    id: string;
    timestamp: Date;
    body: Body;
  }>;
}

/** Parsed batch with typed messages */
export interface ParsedMessageBatch<T> {
  queue: string;
  messages: ParsedQueueMessage<T>[];
}

/**
 * Serialize a queue message using the provided schema.
 * @param schema Zod schema describing the message shape
 * @param message Message payload to validate and serialize
 * @throws MessageProcessingError if validation fails
 */
export function serializeQueueMessage<T>(schema: ZodSchema<T>, message: T): string {
  try {
    const data = schema.parse(message);
    return JSON.stringify(data);
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new MessageProcessingError('Queue message validation failed', { issues: err.format() });
    }
    throw err;
  }
}

/**
 * Parse a queue message body using the given schema.
 * @param schema Zod schema describing the message shape
 * @param body Raw JSON string from the queue
 * @returns Parsed and validated message
 * @throws MessageProcessingError when parsing or validation fails
 */
export function parseQueueMessage<T>(schema: ZodSchema<T>, body: string): T {
  try {
    const parsed = JSON.parse(body);
    return schema.parse(parsed);
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new MessageProcessingError('Invalid JSON in queue message');
    }
    if (err instanceof z.ZodError) {
      throw new MessageProcessingError('Queue message validation failed', { issues: err.format() });
    }
    throw err;
  }
}

/**
 * Convert a raw message batch from Cloudflare to a typed batch.
 * Messages that fail validation will throw a MessageProcessingError.
 */
export function parseMessageBatch<T>(schema: ZodSchema<T>, batch: RawMessageBatch): ParsedMessageBatch<T> {
  const messages = batch.messages.map(m => ({
    id: m.id,
    timestamp: m.timestamp,
    body: parseQueueMessage(schema, m.body),
  }));
  return { queue: batch.queue, messages };
}

/**
 * Convert a Cloudflare MessageBatch to the RawMessageBatch shape expected by
 * parsing helpers.
 */
export function toRawMessageBatch(batch: MessageBatch<any>): RawMessageBatch {
  const messages = batch.messages.map(m => ({
    id: m.id,
    timestamp: m.timestamp instanceof Date ? m.timestamp.getTime() : (m.timestamp as any),
    body: typeof m.body === 'string' ? m.body : JSON.stringify(m.body),
  }));
  return { queue: batch.queue, messages };
}

export * from './AbstractQueue.js';
