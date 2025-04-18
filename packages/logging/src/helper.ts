import { getContext } from 'hono/context-storage';
import { baseLogger, BaseLogger } from './base';

// Define a type for the context storage
interface LoggerContext {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

/**
 * Returns the request‑scoped logger if inside ALS context,
 * otherwise returns the singleton base logger.
 */
export function getLogger(): BaseLogger {
  try {
    const ctx = getContext() as LoggerContext | undefined;
    return (ctx?.get('logger') as BaseLogger) ?? baseLogger;
  } catch (_) {
    console.log('getLogger() failed to get context storage, returning base logger');
    // Not inside ALS – occurs during module init or unit tests
    return baseLogger;
  }
}
