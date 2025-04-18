import { baseLogger } from './base';
import { getContext } from 'hono/context-storage';
import { Logger } from 'pino';

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
  level: string = "info",
  fn: (logger: Logger) => Promise<T> | T,
  ctx?: CFExecutionContext,
): Promise<T> {
  const child = baseLogger.child(meta, { level });
  const execute = () => Promise.resolve(fn(child));
  let als: LoggerContext | undefined;
  try {
    als = getContext() as LoggerContext | undefined;
  } catch (e) {
    child.warn('No async-context, direct logger in use');
    await execute();
  }

  if (ctx?.run) {                               // fetch | scheduled
    return ctx.run(() => {
      if (als) {
        als.set('logger', child);
      }
      return execute();
    });
  }

  if (als) als.set('logger', child);            // already inside ALS
  else child.debug('No async-context, direct logger in use'); // queue/dev

  return execute();
}
