/**
 * Type definitions for Cloudflare Workers
 */

/**
 * Cloudflare Queue interface
 */
interface Queue<T> {
  send(message: T): Promise<void>;
  sendBatch(messages: T[]): Promise<void>;
}

/**
 * Cloudflare AI interface
 */
interface Ai {
  run<T = any>(model: string, options: any): Promise<T>;
}

/**
 * Message batch from queue
 */
interface MessageBatch<T> {
  queue: string;
  messages: { id: string; body: T; timestamp: number }[];
}

/**
 * Scheduled event
 */
interface ScheduledEvent {
  cron: string;
  scheduledTime: number;
}

/**
 * Execution context
 */
interface ExecutionContext {
  waitUntil(promise: Promise<any>): void;
  passThroughOnException(): void;
}

/**
 * Forwardable email message
 */
interface ForwardableEmailMessage {
  readonly from: string;
  readonly to: string[];
  readonly headers: Headers;
  readonly raw: ReadableStream;
  forward(to: string | string[]): Promise<void>;
}

/**
 * Worker entrypoint interface
 */
interface WorkerEntrypoint<E = Env> {
  fetch?: (request: Request, env: E, ctx: ExecutionContext) => Promise<Response>;
  scheduled?: (event: ScheduledEvent, env: E, ctx: ExecutionContext) => Promise<void>;
  queue?: (batch: MessageBatch<any>, env: E) => Promise<void>;
  email?: (message: ForwardableEmailMessage, env: E, ctx: ExecutionContext) => Promise<void>;
}

/**
 * Environment bindings
 */
interface Env {
  // Queue bindings
  NEW_CONTENT: Queue<any>;
  ENRICHED_CONTENT: Queue<any>;
  
  // Service bindings
  SILO: any;
  
  // AI binding
  AI: Ai;
  
  // Environment variables
  LOG_LEVEL: string;
  VERSION: string;
  ENVIRONMENT: string;
}

// Export an empty object to make this a module
export {};
