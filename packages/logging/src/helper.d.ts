import { BaseLogger } from './base';
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
export declare function getLogger(): BaseLogger;
