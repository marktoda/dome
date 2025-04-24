import type { Context, MiddlewareHandler, Next } from 'hono';
import { getLogger, logError } from '@dome/logging';
import { getPath } from 'hono/utils/url';

/**
 * Creates a detailed logger middleware for Hono that logs comprehensive information
 * about requests and responses
 * @returns Middleware handler
 */
export function createDetailedLoggerMiddleware(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const logger = getLogger();
    const startTime = Date.now();

    // Extract request details
    const { method } = c.req;
    const path = getPath(c.req.raw);
    const url = new URL(c.req.url);
    const params = c.req.param();
    const query = c.req.query();

    // Extract request body if it exists
    let requestBody: any = undefined;
    try {
      const contentType = c.req.header('content-type');
      if (contentType && contentType.includes('application/json')) {
        // Clone the request to read its body without consuming it
        const reqClone = c.req.raw.clone();
        const text = await reqClone.text();
        if (text) {
          requestBody = JSON.parse(text);
        }
      }
    } catch (e) {
      // Ignore errors in request body extraction
      logger.debug({ error: e }, 'Failed to extract request body');
    }

    // Log request details
    logger.info(
      {
        request: {
          method,
          path,
          url: url.toString(),
          params: Object.keys(params).length > 0 ? params : undefined,
          query: Object.keys(query).length > 0 ? query : undefined,
          body: requestBody ? sanitizeBody(requestBody) : undefined,
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
          response: {
            status,
            ok: String(c.res.ok),
            time: formatTime(startTime),
            body: responseBody ? sanitizeBody(responseBody) : undefined,
          },
        },
        'Request completed',
      );
    } catch (error) {
      // Log error details
      logger.error(
        {
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
 * Sanitizes body data to prevent logging sensitive information
 * and limit the size of logged data
 * @param body Request or response body
 * @returns Sanitized body
 */
function sanitizeBody(body: any): any {
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
    logError(error, 'Sanitization error');
    return { _error: 'Failed to sanitize body', _type: typeof body };
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
