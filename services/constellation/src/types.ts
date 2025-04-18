import type { MessageData } from '@dome/common';

/**
 * Interface for Workers AI binding
 */
interface WorkersAI {
  run(model: string, options: any): Promise<any>;
}

/**
 * Vector metadata for Vectorize index
 */
export interface VectorMetadata {
  userId: string;
  noteId: string;
  createdAt: number; // seconds since epoch
  version: number;
}

/**
 * Environment bindings for the Constellation Worker
 */
export type Bindings = {
  D1_DATABASE: D1Database;
  VECTORIZE: VectorizeIndex;
  RAW: R2Bucket;
  EVENTS: Queue<MessageData>;
  AI?: WorkersAI; // Optional to support testing environments
};

/**
 * Queue retry options
 */
export interface QueueRetryOptions {
  delaySeconds?: number;
}
