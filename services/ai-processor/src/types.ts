import {
  SiloBatchGetResponse,
} from '@dome/common';

// Define Cloudflare Workers types
export interface Queue<T> {
  send(message: T): Promise<void>;
  sendBatch(messages: T[]): Promise<void>;
}

/**
 * Silo service binding interface
 */
export interface SiloBinding {
  batchGet(data: { ids: string[]; userId?: string | null }): Promise<SiloBatchGetResponse>;
}

/**
 * Message batch from queue
 */
export interface MessageBatch<T> {
  queue: string;
  messages: { id: string; body: T; timestamp: number }[];
}
