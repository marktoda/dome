/**
 * Type definitions for Cloudflare Workers
 */

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  dump(): Promise<ArrayBuffer>;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec<T = unknown>(query: string): Promise<D1Result<T>>;
}

interface D1PreparedStatement {
  bind(...values: any[]): D1PreparedStatement;
  first<T = unknown>(column?: string): Promise<T>;
  run<T = unknown>(): Promise<D1Result<T>>;
  all<T = unknown>(): Promise<D1Result<T>>;
  raw<T = unknown>(): Promise<T[]>;
}

interface D1Result<T = unknown> {
  results?: T[];
  success: boolean;
  error?: string;
  meta?: object;
}

interface Queue {
  send: (message: string) => Promise<void>;
  sendBatch: (messages: string[]) => Promise<void>;
}

interface QueueMessage {
  id: string;
  timestamp: number;
  body: string;
}

interface MessageBatch {
  messages: QueueMessage[];
  ack: (messageId: string) => void;
}

declare module 'common' {
  export * from '../../packages/common/src';
}
