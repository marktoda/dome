import type { MiddlewareHandler } from 'hono';
import type { Logger } from 'pino';
/**
 * Creates a Pino logger middleware for Hono
 * @param logger Optional Pino logger instance (default: creates a new logger with level "info")
 * @returns Middleware handler
 */
export declare function createPinoLoggerMiddleware(logger?: Logger): MiddlewareHandler;
