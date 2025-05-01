import type { Context, MiddlewareHandler, Next } from 'hono';
import { nanoid } from 'nanoid';
import { getLogger } from './getLogger';
import { withLogger } from './withLogger';
import { als } from './runtime';
import type { InitOptions } from './types';

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
    return withLogger(meta, async (logger) => {
      // Store logger and requestId in context
      c.set('logger', logger);
      c.set('requestId', requestId);
      
      // Set response header with request ID for correlation
      c.header('x-request-id', requestId);
      
      // Store metadata in AsyncLocalStorage for use by getRequestId() and similar utilities
      als.getStore()?.set('meta', meta);
      
      if (logRequests) {
        // Attempt to log request body for applicable requests
        let body: string | undefined;
        if (includeRequestBody && 
            c.req.header('content-type')?.includes('application/json') && 
            ['POST', 'PUT', 'PATCH'].includes(c.req.method)) {
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
          `${c.req.method} ${c.req.path}`
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
          `Error handling ${c.req.method} ${c.req.path}`
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
            `${c.req.method} ${c.req.path} ${status} in ${duration.toFixed(2)}ms`
          );
        }
      }
    });
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
 * Gets the current request ID from the Hono context or logger metadata
 * @param c Optional Hono context to extract request ID from
 * @returns The current request ID or undefined if not available
 */
export function getRequestId(c?: Context): string | undefined {
  // Try to get from Hono context first if provided
  if (c && c.get) {
    try {
      const requestId = c.get('requestId');
      if (requestId) return requestId as string;
    } catch {
      // Ignore errors from c.get and try other methods
    }
  }
  
  // Try to get from AsyncLocalStorage metadata
  const store = als.getStore();
  if (store) {
    const meta = store.get('meta') as Record<string, unknown> | undefined;
    if (meta && typeof meta === 'object' && 'requestId' in meta) {
      return meta.requestId as string;
    }
  }
  
  // If all else fails, log a warning and return undefined
  const logger = getLogger();
  logger.warn('Request ID not found in context or metadata');
  return undefined;
}
