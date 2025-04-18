import type { Context, Next } from 'hono';
/**
 * Middleware factory for creating request context middleware
 * @param requestIdHeader The header to use for the request ID (default: X-Request-ID)
 * @returns A middleware function that sets up the request context
 */
export declare function createRequestContextMiddleware(requestIdHeader?: string): (c: Context, next: Next) => Promise<void>;
