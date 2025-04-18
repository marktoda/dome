import { MiddlewareHandler, Hono } from 'hono';
import { contextStorage } from 'hono/context-storage';
import { baseLogger } from './base';
import { nanoid } from 'nanoid';
import type { InitOptions } from './types';

// Extend Request type to include Cloudflare-specific properties
interface CFRequest extends Request {
  cf?: {
    colo?: string;
    [key: string]: any;
  };
}

// Define a type for the Hono context
interface HonoContext {
  req: {
    raw: Request;
    header(name: string): string | undefined;
  };
  set(key: string, value: unknown): void;
}

export function buildLoggingMiddleware(opts: InitOptions = {}): MiddlewareHandler {
  const idFactory = opts.idFactory ?? (() => nanoid(12));
  const extra = opts.extraBindings ?? {};

  return async (c: HonoContext, next: () => Promise<void>) => {
    const reqId = idFactory();
    const cfRequest = c.req.raw as CFRequest;
    
    const child = baseLogger.child({
      reqId,
      ip: c.req.header('CF-Connecting-IP'),
      colo: cfRequest.cf?.colo,
      cfRay: c.req.raw.headers.get('cf-ray'),
      ...extra,
    });

    c.set('logger', child);
    await next();
  };
}

/**
 * Convenience to wire both contextStorage & logging in one call.
 */
export function initLogging(app: any, opts?: InitOptions) {
  app.use(contextStorage());
  app.use('*', buildLoggingMiddleware(opts));
}
