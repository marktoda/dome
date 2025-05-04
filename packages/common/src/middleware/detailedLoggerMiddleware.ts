import type { Context, MiddlewareHandler, Next } from 'hono';
import { nanoid } from 'nanoid';
import pino from 'pino';
import { getLogger, ctx, withContext } from '../context';
import { logError } from '../logging';
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

/**
 * Creates middleware that adds request ID header to all responses
 * @param idFactory Function to generate request IDs
 * @returns Middleware that adds request ID header
 */
export function requestIdMiddleware(idFactory = () => nanoid(12)): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const requestId = c.req.header('x-request-id') || idFactory();
    c.set('requestId', requestId);
    c.header('x-request-id', requestId);
    await next();
  };
}

/**
 * Initializes logging for a Hono application with sensible defaults
 * @param app Hono application instance
 * @param options Configuration options
 */
export function initLogging(app: any, options: InitOptions = {}) {
  // Apply the request ID middleware first
  app.use('*', requestIdMiddleware());

  // Then apply the full logging middleware
  app.use('*', buildLoggingMiddleware(options));
}

/**
 * Configuration options for initializing the logging system
 */
export interface InitOptions {
  /**
   * Factory function to generate unique request IDs
   * Defaults to nanoid(12) if not provided
   */
  idFactory?: () => string;

  /**
   * Additional data to include with every log entry
   * Useful for adding application-wide context like service name, version, etc.
   */
  extraBindings?: Record<string, unknown>;

  /**
   * Log level to use
   * Can be one of: 'trace', 'debug', 'info', 'warn', 'error', 'fatal', or 'silent'
   * Defaults to 'info' if not provided
   */
  level?: pino.LevelWithSilent;

  /**
   * Custom serializer function for log objects
   * Can be used to transform or sanitize log data before output
   */
  serializer?: pino.SerializerFn;
}

/**
 * Extended options for building logging middleware
 */
export interface LoggingMiddlewareOptions extends InitOptions {
  /**
   * Custom function to extract metadata from request
   * @param c Hono context
   * @returns Object with metadata to include in logs
   */
  metadataExtractor?: (c: Context) => Record<string, unknown>;

  /**
   * Log entry and exit of requests
   * @default true
   */
  logRequests?: boolean;

  /**
   * Include request and response headers in logs (sensitive headers will be redacted)
   * @default false
   */
  includeHeaders?: boolean;

  /**
   * Include request body in logs (for small text payloads)
   * @default false
   */
  includeRequestBody?: boolean;

  /**
   * Maximum size in bytes for request bodies to log
   * @default 1024
   */
  maxBodySize?: number;

  /**
   * List of headers that should never be logged
   * @default ['authorization', 'cookie', 'set-cookie']
   */
  sensitiveHeaders?: string[];

  /**
   * Custom function to determine if a request should be logged
   * @param c Hono context
   * @returns true if the request should be logged, false otherwise
   */
  shouldLogRequest?: (c: Context) => boolean;
}

/**
 * Builds a customized logging middleware for Hono
 * @param options Middleware configuration options
 * @returns Configured middleware handler
 */
export function buildLoggingMiddleware(options: LoggingMiddlewareOptions = {}): MiddlewareHandler {
  const {
    idFactory = () => nanoid(12),
    extraBindings = {},
    metadataExtractor,
    logRequests = true,
    includeHeaders = false,
    includeRequestBody = false,
    maxBodySize = 1024,
    sensitiveHeaders = ['authorization', 'cookie', 'set-cookie', 'x-api-key'],
    shouldLogRequest = () => true,
  } = options;

  return async (c: Context, next: Next) => {
    // Skip logging if shouldLogRequest returns false
    if (!shouldLogRequest(c)) {
      return next();
    }

    // Generate or extract request ID
    const requestId = c.req.header('x-request-id') || idFactory();

    // Basic request metadata
    const meta: Record<string, unknown> = {
      reqId: requestId, // Use reqId for backward compatibility with tests
      requestId, // Also include requestId for new code
      path: c.req.path,
      method: c.req.method,
      url: c.req.url,
      ...extraBindings,
    };

    // Add user agent if available
    const userAgent = c.req.header('user-agent');
    if (userAgent) {
      meta.userAgent = userAgent;
    }

    // Add content length if available
    const contentLength = c.req.header('content-length');
    if (contentLength) {
      meta.contentLength = parseInt(contentLength, 10);
    }

    // Add Cloudflare-specific info if available
    const cfData = (c.req.raw as any).cf;
    if (cfData) {
      meta.country = cfData.country;
      meta.colo = cfData.colo;
      meta.clientTrustScore = cfData.clientTrustScore;
    }

    // Add headers if configured
    if (includeHeaders) {
      const safeHeaders: Record<string, string> = {};

      // Extract headers without using entries() method
      const headerEntries: [string, string][] = [];
      c.req.raw.headers.forEach((value, key) => {
        headerEntries.push([key.toLowerCase(), value]);
      });

      const rawHeaders = Object.fromEntries(headerEntries);

      // Filter out sensitive headers
      Object.entries(rawHeaders).forEach(([key, value]) => {
        if (!sensitiveHeaders.includes(key.toLowerCase())) {
          safeHeaders[key] = value as string;
        } else {
          safeHeaders[key] = '[REDACTED]';
        }
      });

      meta.headers = safeHeaders;
    }

    // Add custom metadata if extractor provided
    if (metadataExtractor) {
      Object.assign(meta, metadataExtractor(c));
    }

    // Create logger with all the metadata
    return withContext(meta, async ({ logger }) => {
      // Store logger and requestId in context
      c.set('logger', logger);
      c.set('requestId', requestId);

      // Set response header with request ID for correlation
      c.header('x-request-id', requestId);

      if (logRequests) {
        // Attempt to log request body for applicable requests
        let body: string | undefined;
        if (
          includeRequestBody &&
          c.req.header('content-type')?.includes('application/json') &&
          ['POST', 'PUT', 'PATCH'].includes(c.req.method)
        ) {
          try {
            // Clone the request to avoid consuming it
            const clonedReq = c.req.raw.clone();
            const text = await clonedReq.text();
            if (text && text.length <= maxBodySize) {
              try {
                body = JSON.parse(text);
              } catch {
                body = text.length > 100 ? `${text.substring(0, 100)}...` : text;
              }
            } else if (text) {
              body = `[${text.length} bytes]`;
            }
          } catch {
            // Ignore errors trying to capture body
          }
        }

        logger.info(
          body ? { event: 'request_start', body } : { event: 'request_start' },
          `${c.req.method} ${c.req.path}`,
        );
      }

      const startTime = performance.now();

      try {
        // Process the request
        await next();
      } catch (error) {
        // Log error and rethrow
        logger.error(
          { event: 'request_error', error, path: c.req.path, method: c.req.method },
          `Error handling ${c.req.method} ${c.req.path}`,
        );
        throw error;
      } finally {
        // Calculate duration
        const duration = performance.now() - startTime;

        if (logRequests) {
          // Capture response details
          const status = c.res.status;
          const responseSize = c.res.headers.get('content-length');
          const contentType = c.res.headers.get('content-type');

          // Log request completion
          logger.info(
            {
              event: 'request_end',
              status,
              duration,
              responseSize: responseSize ? parseInt(responseSize, 10) : undefined,
              contentType,
            },
            `${c.req.method} ${c.req.path} ${status} in ${duration.toFixed(2)}ms`,
          );
        }
      }
    });
  };
}
