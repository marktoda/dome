import { MiddlewareHandler, Hono } from 'hono';
import { contextStorage } from 'hono/context-storage';
import { baseLogger } from './base';
import { nanoid } from 'nanoid';
import type { InitOptions } from './types';

/**
 * Extend Request type to include Cloudflare-specific properties
 */
interface CFRequest extends Request {
  cf?: {
    colo?: string;
    [key: string]: unknown;
  };
}

/**
 * Type definition for the Hono context used in middleware
 */
interface HonoContext {
  req: {
    raw: Request;
    header(name: string): string | undefined;
  };
  set(key: string, value: unknown): void;
}

/**
 * Creates a middleware handler that adds request-scoped logging to Hono applications.
 *
 * @param opts - Configuration options for the logging middleware
 * @returns A middleware handler that sets up request-scoped logging
 */
export function buildLoggingMiddleware(opts: InitOptions = {}): MiddlewareHandler {
  const idFactory = opts.idFactory ?? (() => nanoid(12));
  const extra = opts.extraBindings ?? {};

  return async (c: HonoContext, next: () => Promise<void>) => {
    const reqId = idFactory();
    const cfRequest = c.req.raw as CFRequest;

    // Create a child logger with request-specific context
    const child = baseLogger.child({
      reqId,
      ip: c.req.header('CF-Connecting-IP'),
      colo: cfRequest.cf?.colo,
      cfRay: c.req.raw.headers.get('cf-ray'),
      ...extra,
    });

    // Store the logger in the request context
    c.set('logger', child);
    await next();
  };
}

/**
 * Convenience function to wire both contextStorage & logging in one call.
 *
 * @param app - The Hono application instance
 * @param opts - Optional configuration for the logging middleware
 */
export function initLogging(app: Hono<any>, opts?: InitOptions): void {
  app.use(contextStorage());
  app.use('*', buildLoggingMiddleware(opts));
}
