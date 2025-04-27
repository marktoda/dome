import { als, baseLogger } from './runtime';
import type { Logger } from 'pino';

/**
 * Get the current logger from the async local storage or fall back to the base logger
 */
export function getLogger(): Logger {
  return (als.getStore()?.get('logger') as Logger) ?? baseLogger;
}

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
  sensitiveKeys: string[] = ['password', 'token', 'secret', 'key', 'credentials', 'auth']
): T {
  const result = { ...obj };

  Object.keys(result).forEach(key => {
    // Check if this key should be sanitized
    const shouldSanitize = sensitiveKeys.some(
      sensitiveKey => key.toLowerCase().includes(sensitiveKey.toLowerCase())
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
  context: Record<string, unknown> = {}
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
  context: Record<string, unknown> = {}
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    logError(error, errorMessage, context);
    return undefined;
  }
}
