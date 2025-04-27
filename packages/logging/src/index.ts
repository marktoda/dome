import { Context, Next } from 'hono';
import { getLogger, extractErrorInfo, logError } from './getLogger';
import { withLogger } from './withLogger';
import { metrics } from './metrics';
import { baseLogger, als } from './runtime';
import { LogLevel } from './types';

export * from './runtime';
export * from './getLogger';
export * from './withLogger';
export * from './middleware';
export * from './metrics';
export * from './types';
export { LogLevel };

// Standardized logging interface
export interface LoggerOptions {
  service: string;
  component?: string;
  version?: string;
  environment?: string;
}

/**
 * Creates a new logger instance with the specified options
 * @param options Configuration options for the logger
 * @returns A configured logger instance
 */
export function createLogger(options: LoggerOptions) {
  return baseLogger.child({
    service: options.service,
    component: options.component,
    version: options.version,
    environment: options.environment || process.env.ENVIRONMENT || 'development',
  });
}

/**
 * Standard logger middleware for Hono applications that adds request logging
 * and error handling.
 */
export function loggerMiddleware() {
  return async (c: Context, next: Next) => {
    const requestId = c.req.header('x-request-id') || crypto.randomUUID();
    const path = c.req.path;
    const method = c.req.method;
    const userAgent = c.req.header('user-agent');
    const contentLength = c.req.header('content-length');
    const referer = c.req.header('referer');
    
    return withLogger(
      { 
        requestId, 
        path, 
        method, 
        userAgent,
        contentLength: contentLength ? parseInt(contentLength, 10) : undefined,
        referer
      }, 
      async logger => {
        c.set('logger', logger);
        logger.info({ event: 'request_start' });

        const startTime = performance.now();
        try {
          await next();
        } catch (error) {
          const { errorMessage } = extractErrorInfo(error);
          logger.error({ event: 'request_error', error, errorMessage });
          throw error;
        } finally {
          logger.info({
            event: 'request_end',
            duration: performance.now() - startTime,
            status: c.res.status,
          });
        }
      }
    );
  };
}

// Standardized metrics collection
export interface ServiceMetrics {
  counter: (name: string, value?: number, tags?: Record<string, string>) => void;
  gauge: (name: string, value: number, tags?: Record<string, string>) => void;
  timing: (name: string, value: number, tags?: Record<string, string>) => void;
  startTimer: (name: string) => { stop: (tags?: Record<string, string>) => number };
  trackOperation: (name: string, success: boolean, tags?: Record<string, string>) => void;
}

/**
 * Creates a metrics collector for a specific service
 * @param serviceName The name of the service to create metrics for
 * @returns A configured ServiceMetrics instance
 */
export function createServiceMetrics(serviceName: string): ServiceMetrics {
  return {
    counter: (name: string, value = 1, tags = {}) =>
      metrics.increment(`${serviceName}.${name}`, value, tags),
    gauge: (name: string, value: number, tags = {}) =>
      metrics.gauge(`${serviceName}.${name}`, value, tags),
    timing: (name: string, value: number, tags = {}) =>
      metrics.timing(`${serviceName}.${name}`, value, tags),
    startTimer: (name: string) => {
      const timer = metrics.startTimer(`${serviceName}.${name}`);
      return timer;
    },
    trackOperation: (name: string, success: boolean, tags = {}) =>
      metrics.trackOperation(`${serviceName}.${name}`, success, tags),
  };
}

// Common logging pattern helpers
export interface RequestContext {
  path: string;
  method: string;
  requestId: string;
  userAgent?: string;
  ip?: string;
  [key: string]: any;
}

/**
 * Log the start of an operation with standardized format
 * @param operationName Name of the operation being performed
 * @param context Additional context for the operation
 */
export function logOperationStart(operationName: string, context: Record<string, any> = {}) {
  getLogger().info({
    event: `${operationName}_start`,
    ...context
  }, `Started ${operationName}`);
}

/**
 * Log the successful completion of an operation with standardized format
 * @param operationName Name of the operation that completed
 * @param duration Duration of the operation in milliseconds
 * @param context Additional context for the operation
 */
export function logOperationSuccess(operationName: string, duration: number, context: Record<string, any> = {}) {
  getLogger().info({
    event: `${operationName}_success`,
    duration,
    ...context
  }, `Successfully completed ${operationName} in ${duration.toFixed(2)}ms`);
}

/**
 * Log the failure of an operation with standardized format
 * @param operationName Name of the operation that failed
 * @param error The error that caused the failure
 * @param context Additional context for the operation
 */
export function logOperationFailure(operationName: string, error: unknown, context: Record<string, any> = {}) {
  const { errorMessage } = extractErrorInfo(error);
  getLogger().error({
    event: `${operationName}_failure`,
    error,
    errorMessage,
    ...context
  }, `Failed to complete ${operationName}: ${errorMessage}`);
}

/**
 * Wraps an asynchronous operation with standardized start/success/error logging
 * @param operationName Name of the operation to track
 * @param fn The async function to execute
 * @param context Additional context to include in logs
 * @returns The result of the async function
 */
export async function trackOperation<T>(
  operationName: string,
  fn: () => Promise<T>,
  context: Record<string, any> = {}
): Promise<T> {
  logOperationStart(operationName, context);
  const startTime = performance.now();
  
  try {
    const result = await fn();
    const duration = performance.now() - startTime;
    logOperationSuccess(operationName, duration, context);
    return result;
  } catch (error) {
    const duration = performance.now() - startTime;
    logOperationFailure(operationName, error, { ...context, duration });
    throw error;
  }
}

/**
 * Log an external API call with standardized format
 * @param url The URL of the external API
 * @param method The HTTP method used
 * @param status The HTTP status code received
 * @param duration The duration of the call in milliseconds
 * @param context Additional context about the call
 */
export function logExternalCall(
  url: string,
  method: string,
  status: number,
  duration: number,
  context: Record<string, any> = {}
) {
  const isSuccess = status >= 200 && status < 300;
  const logLevel = isSuccess ? 'info' : 'error';
  const logger = getLogger();
  
  logger[logLevel]({
    event: 'external_call',
    url,
    method,
    status,
    duration,
    success: isSuccess,
    ...context
  }, `External ${method} call to ${url} completed with status ${status} in ${duration.toFixed(2)}ms`);
}

/**
 * Utility to make an external API call with standardized logging
 * @param url The URL to call
 * @param options Fetch options
 * @param context Additional context to include in logs
 * @returns The fetch response
 */
export async function trackedFetch(
  url: string,
  options: RequestInit = {},
  context: Record<string, any> = {}
): Promise<Response> {
  const method = options.method || 'GET';
  const requestId = context.requestId || getRequestId();
  
  // Add request ID to headers if available
  const headers = new Headers(options.headers || {});
  if (requestId && !headers.has('x-request-id')) {
    headers.set('x-request-id', requestId);
  }
  
  const startTime = performance.now();
  let response: Response;
  
  try {
    response = await fetch(url, { ...options, headers });
    const duration = performance.now() - startTime;
    
    logExternalCall(
      url,
      method,
      response.status,
      duration,
      context
    );
    
    return response;
  } catch (error) {
    const duration = performance.now() - startTime;
    logOperationFailure('external_call', error, {
      url,
      method,
      duration,
      ...context
    });
    throw error;
  }
}

/**
 * Gets the current request ID from the logger context, if available
 * @returns The current request ID or undefined if not available
 */
export function getRequestId(): string | undefined {
  const store = als.getStore();
  if (!store) return undefined;
  
  const meta = store.get('meta') as Record<string, unknown> | undefined;
  return meta?.requestId as string | undefined;
}
