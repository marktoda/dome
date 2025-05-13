import { getLogger, getRequestId } from '../context/index.js';
import { metrics } from './metrics.js';
export { baseLogger } from './base.js';
export * from './metrics.js';

/**
 * Helper function to properly extract detailed error information for logging
 * @param error The error object to extract information from
 * @returns An object with error and detailed error properties
 */
export function extractErrorInfo(error: unknown): {
  error: unknown;
  errorMessage: string;
  errorName?: string;
  errorCode?: string;
  errorStack?: string;
  statusCode?: number;
  details?: Record<string, any>;
  cause?: unknown;
} {
  // Default values
  let result: {
    error: unknown;
    errorMessage: string;
    errorName?: string;
    errorCode?: string;
    errorStack?: string;
    statusCode?: number;
    details?: Record<string, any>;
    cause?: unknown;
  } = {
    error,
    errorMessage: String(error),
  };

  // For standard Error objects
  if (error instanceof Error) {
    result = {
      ...result,
      errorMessage: error.message,
      errorName: error.name,
      errorStack: error.stack,
    };

    // For errors with cause (Error instances with cause property from ES2022)
    if ('cause' in error) {
      result.cause = error.cause;
    }
  }

  // For dome errors with additional properties
  if (error && typeof error === 'object') {
    const anyError = error as any;

    // Extract common error properties if they exist
    if ('code' in anyError) result.errorCode = anyError.code;
    if ('statusCode' in anyError) result.statusCode = anyError.statusCode;
    if ('details' in anyError) result.details = anyError.details;
  }

  return result;
}

/**
 * Enhanced error logging that properly extracts and includes error information
 * @param error The error object
 * @param message The log message
 * @param additionalContext Additional context to include in the log
 */
export function logError(
  error: unknown,
  message: string,
  additionalContext: Record<string, unknown> = {},
): void {
  const errorInfo = extractErrorInfo(error);
  getLogger().error({ ...errorInfo, ...additionalContext }, message);
}

/**
 * Sanitizes sensitive data from objects before logging
 * @param obj Object to sanitize
 * @param sensitiveKeys Array of sensitive key names to mask
 * @returns Sanitized copy of the object
 */
export function sanitizeForLogging<T extends Record<string, any>>(
  obj: T,
  sensitiveKeys: string[] = ['password', 'token', 'secret', 'key', 'credentials', 'auth'],
): T {
  const result = { ...obj };

  Object.keys(result).forEach(key => {
    // Check if this key should be sanitized
    const shouldSanitize = sensitiveKeys.some(sensitiveKey =>
      key.toLowerCase().includes(sensitiveKey.toLowerCase()),
    );

    if (shouldSanitize) {
      // Mask the value based on its type
      if (typeof result[key] === 'string') {
        const value = result[key] as string;
        if (value.length > 0) {
          result[key as keyof T] = '***' as any;
        }
      } else if (result[key as keyof T] !== null && typeof result[key as keyof T] === 'object') {
        // Recursively sanitize nested objects
        result[key as keyof T] = sanitizeForLogging(result[key as keyof T], sensitiveKeys) as any;
      }
    } else if (result[key as keyof T] !== null && typeof result[key as keyof T] === 'object') {
      // Recursively check nested objects even if the parent key isn't sensitive
      result[key as keyof T] = sanitizeForLogging(result[key as keyof T], sensitiveKeys) as any;
    }
  });

  return result;
}

/**
 * Create a context-bound error logger
 * @param context Context information to include with every log
 * @returns A function that can be used to log errors with the provided context
 */
export function createErrorLogger(context: Record<string, unknown>) {
  return (error: unknown, message: string, additionalContext: Record<string, unknown> = {}) => {
    logError(error, message, { ...context, ...additionalContext });
  };
}

/**
 * Try to execute a function and log any errors that occur
 * @param fn Function to execute
 * @param errorMessage Message to log if an error occurs
 * @param context Additional context to include in error logs
 * @returns The result of the function or undefined if an error occurred
 */
export function tryWithErrorLogging<T>(
  fn: () => T,
  errorMessage: string,
  context: Record<string, unknown> = {},
): T | undefined {
  try {
    return fn();
  } catch (error) {
    logError(error, errorMessage, context);
    return undefined;
  }
}

/**
 * Try to execute an async function and log any errors that occur
 * @param fn Async function to execute
 * @param errorMessage Message to log if an error occurs
 * @param context Additional context to include in error logs
 * @returns A promise that resolves to the result of the function or undefined if an error occurred
 */
export async function tryWithErrorLoggingAsync<T>(
  fn: () => Promise<T>,
  errorMessage: string,
  context: Record<string, unknown> = {},
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    logError(error, errorMessage, context);
    return undefined;
  }
}

/**
 * Log the start of an operation with standardized format
 * @param operationName Name of the operation being performed
 * @param context Additional context for the operation
 */
export function logOperationStart(operationName: string, context: Record<string, any> = {}) {
  getLogger().info(
    {
      event: `${operationName}_start`,
      ...context,
    },
    `Started ${operationName}`,
  );
}

/**
 * Log the successful completion of an operation with standardized format
 * @param operationName Name of the operation that completed
 * @param duration Duration of the operation in milliseconds
 * @param context Additional context for the operation
 */
export function logOperationSuccess(
  operationName: string,
  duration: number,
  context: Record<string, any> = {},
) {
  getLogger().info(
    {
      event: `${operationName}_success`,
      duration,
      ...context,
    },
    `Successfully completed ${operationName} in ${duration.toFixed(2)}ms`,
  );
}

/**
 * Log the failure of an operation with standardized format
 * @param operationName Name of the operation that failed
 * @param error The error that caused the failure
 * @param context Additional context for the operation
 */
export function logOperationFailure(
  operationName: string,
  error: unknown,
  context: Record<string, any> = {},
) {
  const { errorMessage } = extractErrorInfo(error);
  getLogger().error(
    {
      event: `${operationName}_failure`,
      error,
      errorMessage,
      ...context,
    },
    `Failed to complete ${operationName}: ${errorMessage}`,
  );
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
  context: Record<string, any> = {},
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
  context: Record<string, any> = {},
) {
  const isSuccess = status >= 200 && status < 300;
  const logLevel = isSuccess ? 'info' : 'error';
  const logger = getLogger();

  logger[logLevel](
    {
      event: 'external_call',
      url,
      method,
      status,
      duration,
      success: isSuccess,
      ...context,
    },
    `External ${method} call to ${url} completed with status ${status} in ${duration.toFixed(2)}ms`,
  );
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
  context: Record<string, any> = {},
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

    logExternalCall(url, method, response.status, duration, context);

    return response;
  } catch (error) {
    const duration = performance.now() - startTime;
    logOperationFailure('external_call', error, {
      url,
      method,
      duration,
      ...context,
    });
    throw error;
  }
}
