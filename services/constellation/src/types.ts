/**
 * Constellation service types
 *
 * This file defines internal types used by the Constellation service that are not
 * exposed to external consumers. These types support the internal implementation
 * of the service's core functionality.
 */

import { VectorMeta, SiloBatchGetInput, SiloBatchGetResponse } from '@dome/common';

export interface SiloService {
  batchGet(data: SiloBatchGetInput): Promise<SiloBatchGetResponse>;
}

/**
 * Vector with metadata for upsert operations
 *
 * Represents a complete vector with its embedding values and associated metadata
 * ready for storage in the Vectorize index.
 *
 * @property id - Unique identifier for the vector, typically in the format "content:{contentId}:{chunkIndex}"
 * @property values - The actual vector embedding as an array of floating-point numbers
 * @property metadata - Associated metadata for filtering and identification
 *
 * @example
 * ```typescript
 * const vector: VectorWithMetadata = {
 *   id: 'content:content123:0',
 *   values: [0.1, 0.2, 0.3, ...], // 384-dimensional vector
 *   metadata: {
 *     userId: 'user123',
 *     contentId: 'content123',
 *     category: 'note',
 *     mimeType: 'text/markdown',
 *     createdAt: 1650000000,
 *     version: 1
 *   }
 * };
 * ```
 */
export interface VectorWithMetadata {
  id: string;
  values: number[];
  metadata: VectorMeta;
}

/**
 * Message interface for queue operations
 *
 * Represents a message received from a Cloudflare Workers Queue.
 * This interface provides access to the message body and methods for
 * acknowledging or retrying the message.
 *
 * @property id - Unique identifier for the queue message
 * @property timestamp - Date when the message was enqueued
 * @property body - The actual message payload of type T
 * @property attempts - Number of processing attempts for this message
 * @property retry - Method to retry the message with optional delay
 * @property ack - Method to acknowledge successful processing
 *
 * @example
 * ```typescript
 * // Process a queue message
 * async function processMessage(message: QueueMessage<SiloEmbedJob>) {
 *   try {
 *     await processJob(message.body);
 *     message.ack();
 *   } catch (error) {
 *     if (message.attempts < 3) {
 *       message.retry({ delaySeconds: 60 });
 *     } else {
 *       // Send to dead letter queue
 *     }
 *   }
 * }
 * ```
 */
export interface QueueMessage<T> {
  id: string;
  timestamp: Date;
  body: T;
  attempts: number;
  retry(options?: { delaySeconds?: number }): void;
  ack(): void;
}

/**
 * Execution context with run method for logging
 *
 * Extends the standard Cloudflare ExecutionContext with a run method
 * that provides structured logging capabilities.
 *
 * This interface is used to ensure proper context propagation for
 * logging and metrics throughout asynchronous operations.
 *
 * @example
 * ```typescript
 * async function handleRequest(request: Request, env: Env, ctx: CFExecutionContext) {
 *   return ctx.run(async () => {
 *     // All operations in this callback will have the same logging context
 *     logger.info('Processing request');
 *     const result = await processData();
 *     logger.info('Request processed');
 *     return new Response(result);
 *   });
 * }
 * ```
 */
export interface CFExecutionContext extends ExecutionContext {
  run<T>(callback: () => T): Promise<T>;
}
