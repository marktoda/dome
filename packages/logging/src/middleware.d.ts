import { MiddlewareHandler, Hono } from 'hono';
import type { InitOptions } from './types';
/**
 * Creates a middleware handler that adds request-scoped logging to Hono applications.
 *
 * @param opts - Configuration options for the logging middleware
 * @returns A middleware handler that sets up request-scoped logging
 */
export declare function buildLoggingMiddleware(opts?: InitOptions): MiddlewareHandler;
/**
 * Convenience function to wire both contextStorage & logging in one call.
 *
 * @param app - The Hono application instance
 * @param opts - Optional configuration for the logging middleware
 */
export declare function initLogging(app: Hono<any>, opts?: InitOptions): void;
