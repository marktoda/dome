import type { Context, Next } from 'hono';
/**
 * Base error class for all Dome application errors.
 * Provides a consistent error interface with code, status code, and additional details.
 */
export declare class DomeError extends Error {
  readonly code: string;
  readonly statusCode: number;
  details?: Record<string, any>;
  readonly cause?: Error;
  constructor(
    message: string,
    options: {
      code: string;
      statusCode?: number;
      details?: Record<string, any>;
      cause?: Error;
    },
  );
  /**
   * Converts the error to a JSON-serializable object
   * @returns A plain object representation of the error
   */
  toJSON(): Record<string, any>;
  /**
   * Creates a user-friendly representation of the error for API responses
   * @returns An object suitable for returning to API clients
   */
  toApiResponse(): {
    error: {
      code: string;
      message: string;
      details?: Record<string, any>;
    };
  };
  /**
   * Add additional context to the error's details
   * @param context Additional context to add to the error details
   * @returns This error instance (for chaining)
   */
  withContext(context: Record<string, any>): this;
}
/**
 * Error for validation failures (HTTP 400)
 */
export declare class ValidationError extends DomeError {
  constructor(message: string, details?: Record<string, any>, cause?: Error);
}
/**
 * Error for resource not found (HTTP 404)
 */
export declare class NotFoundError extends DomeError {
  constructor(message: string, details?: Record<string, any>, cause?: Error);
}
/**
 * Error for authentication failures (HTTP 401)
 */
export declare class UnauthorizedError extends DomeError {
  constructor(message: string, details?: Record<string, any>, cause?: Error);
}
/**
 * Error for permission/authorization failures (HTTP 403)
 */
export declare class ForbiddenError extends DomeError {
  constructor(message: string, details?: Record<string, any>, cause?: Error);
}
/**
 * Error for malformed requests (HTTP 400)
 */
export declare class BadRequestError extends DomeError {
  constructor(message: string, details?: Record<string, any>, cause?: Error);
}
/**
 * Error for internal server errors (HTTP 500)
 */
export declare class InternalError extends DomeError {
  constructor(message: string, details?: Record<string, any>, cause?: Error);
}
/**
 * Error for service unavailable errors (HTTP 503)
 */
export declare class ServiceUnavailableError extends DomeError {
  constructor(message: string, details?: Record<string, any>, cause?: Error);
}
/**
 * Error for rate limiting (HTTP 429)
 */
export declare class RateLimitError extends DomeError {
  constructor(message: string, details?: Record<string, any>, cause?: Error);
}
/**
 * Error for conflicts (HTTP 409)
 */
export declare class ConflictError extends DomeError {
  constructor(message: string, details?: Record<string, any>, cause?: Error);
}
/**
 * Backup logger implementation if no logger is available in context
 */
export declare function getLogger(): {
  error: {
    (...data: any[]): void;
    (message?: any, ...optionalParams: any[]): void;
  };
  warn: {
    (...data: any[]): void;
    (message?: any, ...optionalParams: any[]): void;
  };
  info: {
    (...data: any[]): void;
    (message?: any, ...optionalParams: any[]): void;
  };
  debug: {
    (...data: any[]): void;
    (message?: any, ...optionalParams: any[]): void;
  };
};
/**
 * Options for error handler middleware
 */
export interface ErrorHandlerOptions {
  /**
   * Whether to include stack traces in error responses (non-production only)
   * @default false
   */
  includeStack?: boolean;
  /**
   * Whether to include error causes in error responses (non-production only)
   * @default false
   */
  includeCause?: boolean;
  /**
   * Custom error mapping function
   * @param err The caught error
   * @returns A DomeError instance
   */
  errorMapper?: (err: unknown) => DomeError;
  /**
   * Function to extract the logger from context
   * @param c Hono context
   * @returns A logger instance
   */
  getContextLogger?: (c: Context) => {
    error: (...args: unknown[]) => void;
  };
}
/**
 * Error handler middleware for Hono applications
 * @param options Configuration options
 * @returns Middleware function
 */
export declare function errorHandler(
  options?: ErrorHandlerOptions,
): (
  c: Context,
  next: Next,
) => Promise<(Response & import('hono').TypedResponse<never>) | undefined>;
/**
 * Utility to convert unknown errors to DomeErrors
 * @param error Any error or exception
 * @param defaultMessage Message to use if error is not an Error instance
 * @param defaultDetails Details to include if none available
 * @returns A DomeError instance
 */
export declare function toDomeError(
  error: unknown,
  defaultMessage?: string,
  defaultDetails?: Record<string, any>,
): DomeError;
/**
 * Creates a function that wraps async operations with error handling
 * @param defaultMessage Default error message to use
 * @param defaultDetails Default details to include with errors
 * @returns A function that wraps an async operation
 */
export declare function createErrorWrapper(
  defaultMessage: string,
  defaultDetails?: Record<string, any>,
): <T>(fn: () => Promise<T>, message?: string, details?: Record<string, any>) => Promise<T>;
/**
 * Helper to assert a condition, throws ValidationError if false
 * @param condition Condition to check
 * @param message Error message if condition is false
 * @param details Additional error details
 */
export declare function assertValid(
  condition: boolean,
  message: string,
  details?: Record<string, any>,
): void;
/**
 * Helper to assert that a value exists, throws NotFoundError if undefined/null
 * @param value Value to check
 * @param message Error message if value doesn't exist
 * @param details Additional error details
 * @returns The non-null value (TypeScript helper)
 */
export declare function assertExists<T>(
  value: T | null | undefined,
  message: string,
  details?: Record<string, any>,
): T;
/**
 * Utility to handle database errors and convert them to appropriate DomeErrors
 * @param error The caught error
 * @param operation Description of the operation that failed
 * @param details Additional context details
 * @returns A DomeError with appropriate type
 */
export declare function handleDatabaseError(
  error: unknown,
  operation: string,
  details?: Record<string, any>,
): DomeError;
/**
 * Create a specialized error handler for a specific domain/service
 * @param domain Domain or service name for context
 * @param defaultDetails Default details to include in all errors
 * @returns Object with error helper methods
 */
export declare function createErrorFactory(
  domain: string,
  defaultDetails?: Record<string, any>,
): {
  validation: (message: string, details?: Record<string, any>, cause?: Error) => ValidationError;
  notFound: (message: string, details?: Record<string, any>, cause?: Error) => NotFoundError;
  unauthorized: (
    message: string,
    details?: Record<string, any>,
    cause?: Error,
  ) => UnauthorizedError;
  forbidden: (message: string, details?: Record<string, any>, cause?: Error) => ForbiddenError;
  badRequest: (message: string, details?: Record<string, any>, cause?: Error) => BadRequestError;
  internal: (message: string, details?: Record<string, any>, cause?: Error) => InternalError;
  conflict: (message: string, details?: Record<string, any>, cause?: Error) => ConflictError;
  serviceUnavailable: (
    message: string,
    details?: Record<string, any>,
    cause?: Error,
  ) => ServiceUnavailableError;
  rateLimit: (message: string, details?: Record<string, any>, cause?: Error) => RateLimitError;
  wrap: <T>(fn: () => Promise<T>, message?: string, details?: Record<string, any>) => Promise<T>;
  assertValid: (condition: boolean, message: string, details?: Record<string, any>) => void;
  assertExists: <T>(
    value: T | null | undefined,
    message: string,
    details?: Record<string, any>,
  ) => T;
  handleDatabaseError: (
    error: unknown,
    operation: string,
    details?: Record<string, any>,
  ) => DomeError;
};
