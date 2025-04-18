import { baseLogger } from './base';
import { getContext } from 'hono/context-storage';

/**
 * Interface for Cloudflare Workers ExecutionContext
 */
interface CFExecutionContext {
  run<T>(callback: () => T): Promise<T>;
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

/**
 * Interface for the logger context storage
 */
interface LoggerContext {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

/**
 * Runs a function with a logger attached to the execution context.
 *
 * @remarks
 * This function creates a child logger with the provided metadata and attaches it
 * to the execution context. If the context has a run method, it will use that to
 * ensure the logger is available throughout the execution. If there's no context
 * or if accessing the context fails, it will fall back to running the function directly.
 *
 * @param meta - Metadata to attach to the logger
 * @param fn - The function to run with the logger
 * @param ctx - Optional Cloudflare Workers execution context
 * @returns The result of the function execution
 */
export async function runWithLogger<T>(
  meta: Record<string, unknown>,
  fn: () => Promise<T>,
  ctx?: CFExecutionContext,
): Promise<T> {
  const child = baseLogger.child(meta);
  
  try {
    const storage = getContext() as LoggerContext | undefined;

    if (ctx?.run) {
      return await ctx.run(() => {
        if (storage) {
          storage.set('logger', child);
        }
        return fn();
      });
    }

    return await fn();
  } catch (error) {
    // If accessing context storage fails, log the error and fall back to direct execution
    child.warn(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      'Failed to access context storage in runWithLogger, falling back to direct execution'
    );
    return await fn();
  }
}
