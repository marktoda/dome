import type { Context, MiddlewareHandler, Next } from 'hono';
import { getPath } from 'hono/utils/url';
import pino from 'pino';

/**
 * Creates a detailed logger middleware for Hono that logs comprehensive information
 * about requests and responses
 * @returns Middleware handler
 */
export function createDetailedLoggerMiddleware(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    // Get logger from context or create a new one
    const logger = c.get('logger') || pino({ level: 'info' });
    const requestId = c.get('requestId') || 'unknown';
    const startTime = Date.now();

    // Extract request details
    const { method } = c.req;
    const path = getPath(c.req.raw);
    const url = new URL(c.req.url);
    const params = c.req.param();
    const query = c.req.query();

    // Log request details
    logger.info(
      {
        requestId,
        request: {
          method,
          path,
          url: url.toString(),
          params: Object.keys(params).length > 0 ? params : undefined,
          query: Object.keys(query).length > 0 ? query : undefined,
        },
      },
      'Incoming request',
    );

    // We'll capture response body in the response hook
    let responseBody: any = undefined;

    try {
      // Process the request
      await next();

      // Try to extract response body if it's a JSON response
      try {
        const contentType = c.res.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          // Clone the response to read its body without consuming it
          const resClone = c.res.clone();
          const text = await resClone.text();
          if (text) {
            responseBody = JSON.parse(text);
          }
        }
      } catch (e) {
        // Ignore errors in response body extraction
        logger.debug({ error: e }, 'Failed to extract response body');
      }

      // Extract response details
      const { status } = c.res;

      // Log response details
      logger.info(
        {
          requestId,
          response: {
            status,
            ok: String(c.res.ok),
            time: formatTime(startTime),
            body: responseBody ? sanitizeResponseBody(responseBody) : undefined,
          },
        },
        'Request completed',
      );
    } catch (error) {
      // Log error details
      logger.error(
        {
          requestId,
          error:
            error instanceof Error
              ? {
                  name: error.name,
                  message: error.message,
                  stack: error.stack,
                }
              : String(error),
          request: {
            method,
            path,
          },
          time: formatTime(startTime),
        },
        'Request failed',
      );
      throw error;
    }
  };
}

/**
 * Sanitizes response body to prevent logging sensitive information
 * and limit the size of logged data
 * @param body Response body
 * @returns Sanitized response body
 */
function sanitizeResponseBody(body: any): any {
  if (!body) return undefined;

  try {
    // If body is an object, sanitize it
    if (typeof body === 'object') {
      // Create a shallow copy to avoid modifying the original
      const sanitized = Array.isArray(body) ? [...body] : { ...body };

      // Remove sensitive fields
      const sensitiveFields = ['password', 'token', 'secret', 'key', 'auth'];

      if (!Array.isArray(sanitized)) {
        for (const field of sensitiveFields) {
          for (const key of Object.keys(sanitized)) {
            if (key.toLowerCase().includes(field)) {
              sanitized[key] = '[REDACTED]';
            }
          }
        }
      }

      // Limit size of response for logging
      const stringified = JSON.stringify(sanitized);
      if (stringified.length > 1000) {
        return {
          _truncated: true,
          _originalSize: stringified.length,
          _preview: JSON.parse(stringified.substring(0, 1000) + '..."}'),
        };
      }

      return sanitized;
    }

    // If body is a string, limit its size
    if (typeof body === 'string' && body.length > 1000) {
      return body.substring(0, 1000) + '... [truncated]';
    }

    return body;
  } catch (error) {
    return { _error: 'Failed to sanitize response body', _type: typeof body };
  }
}

/**
 * Formats the elapsed time in milliseconds or seconds
 * @param start Start time in milliseconds
 * @returns Formatted time string
 */
function formatTime(start: number): string {
  const delta = Date.now() - start;
  return delta < 1000 ? `${delta}ms` : `${Math.round(delta / 1000)}s`;
}
