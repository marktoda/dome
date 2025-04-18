import { getContext } from 'hono/context-storage';
import { baseLogger, BaseLogger } from './base';

/**
 * Interface defining the expected shape of the logger context storage
 */
interface LoggerContext {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

/**
 * Returns the request-scoped logger if inside an Async Local Storage context,
 * otherwise returns the singleton base logger.
 *
 * @remarks
 * This function attempts to retrieve a logger from the current Hono context.
 * If no context is available (e.g., during module initialization or in unit tests),
 * it falls back to the global base logger.
 *
 * @returns The appropriate logger instance for the current context
 */
export function getLogger(): BaseLogger {
  try {
    const ctx = getContext() as LoggerContext | undefined;
    return (ctx?.get('logger') as BaseLogger) ?? baseLogger;
  } catch (error) {
    // Not inside ALS – occurs during module init or unit tests
    console.log(
      `getLogger() failed to get context storage: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    );
    return baseLogger;
  }
}
