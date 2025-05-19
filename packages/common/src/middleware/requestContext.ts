import type { Context, Next } from 'hono';
import crypto from 'node:crypto';

/**
 * Middleware factory for creating request context middleware
 * @param requestIdHeader The header to use for the request ID (default: X-Request-ID)
 * @returns A middleware function that sets up the request context
 */
export function createRequestContextMiddleware(
  requestIdHeader = 'X-Request-ID',
): (c: Context, next: Next) => Promise<void> {
  return async (c: Context, next: Next): Promise<void> => {
    // Get the request ID from the header or generate a new one
    const requestId =
      c.req.header(requestIdHeader) ||
      c.get('requestId') ||
      crypto.randomUUID();

    // Set the request ID in the context for backward compatibility
    c.set('requestId', requestId);

    // Add the request ID to the response headers
    c.header('X-Request-ID', requestId);

    await next();
  };
}
