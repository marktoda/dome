/**
 * Constellation service types
 */

import { NoteVectorMeta } from '@dome/common';

/**
 * Vector with metadata for upsert operations
 */
export interface VectorWithMetadata {
  id: string;
  values: number[];
  metadata: NoteVectorMeta;
}

/**
 * Message interface for queue operations
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
 */
export interface CFExecutionContext extends ExecutionContext {
  run<T>(callback: () => T): Promise<T>;
}
