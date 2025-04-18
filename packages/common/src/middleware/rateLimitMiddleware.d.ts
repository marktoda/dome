import type { Context, MiddlewareHandler } from 'hono';
/**
 * Creates a rate limiting middleware
 * @param windowMs Time window in milliseconds (default: 60000 ms = 1 minute)
 * @param maxRequests Maximum number of requests allowed in the time window (default: 100)
 * @param keyGenerator Function to generate a key for the client (default: uses IP address)
 * @returns Middleware handler
 */
export declare function createRateLimitMiddleware(
  windowMs?: number,
  maxRequests?: number,
  keyGenerator?: (c: Context) => string,
): MiddlewareHandler;
