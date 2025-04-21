import { SiloBatchGetInput, SiloBatchGetResponse } from '@dome/common';

// Define Cloudflare Workers types
export interface Queue<T> {
  send(message: T): Promise<void>;
  sendBatch(messages: T[]): Promise<void>;
}


export interface SiloBinding {
  batchGet(data: SiloBatchGetInput): Promise<SiloBatchGetResponse>;
}

/**
 * Message batch from queue
 */
export interface MessageBatch<T> {
  queue: string;
  messages: { id: string; body: T; timestamp: number }[];
}
