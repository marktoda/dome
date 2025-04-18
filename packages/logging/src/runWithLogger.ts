import { baseLogger } from './base';
import { getContext } from 'hono/context-storage';

// Extend ExecutionContext to include run method
interface CFExecutionContext {
  run<T>(callback: () => T): Promise<T>;
  waitUntil(promise: Promise<any>): void;
  passThroughOnException(): void;
}

// Define a type for the context storage
interface LoggerContext {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

export async function runWithLogger<T>(
  meta: object,
  fn: () => Promise<T>,
  ctx?: CFExecutionContext,
): Promise<T> {
  const child = baseLogger.child(meta);
  const storage = getContext() as LoggerContext | undefined;
  // If no ALS context yet, fall back to base run
  if (!storage) return await fn();

  if (ctx?.run) {
    return await ctx.run(() => {
      if (storage) {
        storage.set('logger', child);
      }
      return fn();
    });
  }
  
  return await fn();
}