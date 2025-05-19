// Import Hono types
import type { Context, Next } from 'hono';

/**
 * Base error class for all Dome application errors.
 * Provides a consistent error interface with code, status code, and additional details.
 */
export class DomeError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public details?: Record<string, any>;
  public readonly cause?: Error;

  constructor(
    message: string,
    options: {
      code: string;
      statusCode?: number;
      details?: Record<string, any>;
      cause?: Error;
    },
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = options.code;
    this.statusCode = options.statusCode || 500;
    this.details = options.details;
    this.cause = options.cause;

    // Capture stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Converts the error to a JSON-serializable object
   * @returns A plain object representation of the error
   */
  toJSON(): Record<string, any> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      statusCode: this.statusCode,
      details: this.details,
      stack: process.env.NODE_ENV !== 'production' ? this.stack : undefined,
      cause:
        this.cause instanceof Error
          ? this.cause instanceof DomeError
            ? this.cause.toJSON()
            : this.cause.message
          : this.cause,
    };
  }

  /**
   * Creates a user-friendly representation of the error for API responses
   * @returns An object suitable for returning to API clients
   */
  toApiResponse(): { error: { code: string; message: string; details?: Record<string, any> } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
      },
    };
  }

  /**
   * Add additional context to the error's details
   * @param context Additional context to add to the error details
   * @returns This error instance (for chaining)
   */
  withContext(context: Record<string, any>): this {
    this.details = { ...this.details, ...context };
    return this;
  }
}

/**
 * Error for validation failures (HTTP 400)
 */
export class ValidationError extends DomeError {
  constructor(message: string, details?: Record<string, any>, cause?: Error) {
    super(message, {
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      details,
      cause,
    });
  }
}

/**
 * Error for resource not found (HTTP 404)
 */
export class NotFoundError extends DomeError {
  constructor(message: string, details?: Record<string, any>, cause?: Error) {
    super(message, {
      code: 'NOT_FOUND',
      statusCode: 404,
      details,
      cause,
    });
  }
}

/**
 * Error for authentication failures (HTTP 401)
 */
export class UnauthorizedError extends DomeError {
  constructor(message: string, details?: Record<string, any>, cause?: Error) {
    super(message, {
      code: 'UNAUTHORIZED',
      statusCode: 401,
      details,
      cause,
    });
  }
}

/**
 * Error for permission/authorization failures (HTTP 403)
 */
export class ForbiddenError extends DomeError {
  constructor(message: string, details?: Record<string, any>, cause?: Error) {
    super(message, {
      code: 'FORBIDDEN',
      statusCode: 403,
      details,
      cause,
    });
  }
}

/**
 * Error for malformed requests (HTTP 400)
 */
export class BadRequestError extends DomeError {
  constructor(message: string, details?: Record<string, any>, cause?: Error) {
    super(message, {
      code: 'BAD_REQUEST',
      statusCode: 400,
      details,
      cause,
    });
  }
}

/**
 * Error for internal server errors (HTTP 500)
 */
export class InternalError extends DomeError {
  constructor(message: string, details?: Record<string, any>, cause?: Error) {
    super(message, {
      code: 'INTERNAL_ERROR',
      statusCode: 500,
      details,
      cause,
    });
  }
}

/**
 * Error for service unavailable errors (HTTP 503)
 */
export class ServiceUnavailableError extends DomeError {
  constructor(message: string, details?: Record<string, any>, cause?: Error) {
    super(message, {
      code: 'SERVICE_UNAVAILABLE',
      statusCode: 503,
      details,
      cause,
    });
  }
}

/**
 * Error for rate limiting (HTTP 429)
 */
export class RateLimitError extends DomeError {
  constructor(message: string, details?: Record<string, any>, cause?: Error) {
    super(message, {
      code: 'RATE_LIMIT_EXCEEDED',
      statusCode: 429,
      details,
      cause,
    });
  }
}

/**
 * Error for conflicts (HTTP 409)
 */
export class ConflictError extends DomeError {
  constructor(message: string, details?: Record<string, any>, cause?: Error) {
    super(message, {
      code: 'CONFLICT',
      statusCode: 409,
      details,
      cause,
    });
  }
}

/**
 * Backup logger implementation if no logger is available in context
 */
export function getLogger() {
  return {
    error: console.error,
    warn: console.warn,
    info: console.info,
    debug: console.debug,
  };
}

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
export function errorHandler(options: ErrorHandlerOptions = {}) {
  const {
    includeStack = process.env.NODE_ENV !== 'production',
    includeCause = process.env.NODE_ENV !== 'production',
    errorMapper,
    getContextLogger,
  } = options;

  return async (c: Context, next: Next) => {
    try {
      await next();
    } catch (err) {
      // Get logger from context or fallback
      const logger = getContextLogger ? getContextLogger(c) : c.get('logger') || getLogger();

      // Convert error to DomeError
      const error = errorMapper
        ? errorMapper(err)
        : err instanceof DomeError
        ? err
        : new InternalError(
            'An unexpected error occurred',
            {},
            err instanceof Error ? err : undefined,
          );

      // Log error
      logger.error({
        event: 'error_handled',
        error: error.toJSON(),
        path: c.req?.path,
        method: c.req?.method,
      });

      // Set response status
      c.status(error.statusCode);

      // Create response body
      const responseBody: any = {
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      };

      // Include stack traces and cause if configured
      if (includeStack) {
        responseBody.error.stack = error.stack;
      }

      if (includeCause && error.cause) {
        responseBody.error.cause =
          error.cause instanceof Error ? error.cause.message : String(error.cause);

        if (includeStack && error.cause instanceof Error) {
          responseBody.error.causeStack = error.cause.stack;
        }
      }

      return c.json(responseBody);
    }
  };
}

/**
 * Utility to convert unknown errors to DomeErrors
 * @param error Any error or exception
 * @param defaultMessage Message to use if error is not an Error instance
 * @param defaultDetails Details to include if none available
 * @returns A DomeError instance
 */
export function toDomeError(
  error: unknown,
  defaultMessage = 'An unexpected error occurred',
  defaultDetails: Record<string, any> = {},
): DomeError {
  // Already a DomeError
  if (error instanceof DomeError) {
    // Merge the provided details with existing details
    if (Object.keys(defaultDetails).length > 0) {
      error.withContext(defaultDetails);
    }
    return error;
  }

  // Standard Error
  if (error instanceof Error) {
    // Check for common status code patterns
    const statusMatch = error.message.match(/(\b4\d\d\b|\b5\d\d\b)/);
    const statusCode = statusMatch ? parseInt(statusMatch[1]) : undefined;

    if (statusCode === 400) {
      return new BadRequestError(error.message, defaultDetails, error);
    } else if (statusCode === 401) {
      return new UnauthorizedError(error.message, defaultDetails, error);
    } else if (statusCode === 403) {
      return new ForbiddenError(error.message, defaultDetails, error);
    } else if (statusCode === 404) {
      return new NotFoundError(error.message, defaultDetails, error);
    } else if (statusCode === 409) {
      return new ConflictError(error.message, defaultDetails, error);
    } else if (statusCode === 429) {
      return new RateLimitError(error.message, defaultDetails, error);
    } else if (statusCode === 503) {
      return new ServiceUnavailableError(error.message, defaultDetails, error);
    } else {
      return new InternalError(error.message, defaultDetails, error);
    }
  }

  // String error
  if (typeof error === 'string') {
    return new InternalError(error, defaultDetails);
  }

  // Object error
  if (error && typeof error === 'object') {
    const objError = error as Record<string, any>;
    const message = objError.message || defaultMessage;
    const details = objError.details || defaultDetails;
    return new InternalError(String(message), details);
  }

  // Unknown error type
  return new InternalError(defaultMessage, defaultDetails);
}

/**
 * Creates a function that wraps async operations with error handling
 * @param defaultMessage Default error message to use
 * @param defaultDetails Default details to include with errors
 * @returns A function that wraps an async operation
 */
export function createErrorWrapper(
  defaultMessage: string,
  defaultDetails: Record<string, any> = {},
) {
  return async function wrapWithErrorHandling<T>(
    fn: () => Promise<T>,
    message = defaultMessage,
    details: Record<string, any> = {},
  ): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw toDomeError(error, message, { ...defaultDetails, ...details });
    }
  };
}

/**
 * Helper to assert a condition, throws ValidationError if false
 * @param condition Condition to check
 * @param message Error message if condition is false
 * @param details Additional error details
 */
export function assertValid(
  condition: boolean,
  message: string,
  details: Record<string, any> = {},
): void {
  if (!condition) {
    throw new ValidationError(message, details);
  }
}

/**
 * Helper to assert that a value exists, throws NotFoundError if undefined/null
 * @param value Value to check
 * @param message Error message if value doesn't exist
 * @param details Additional error details
 * @returns The non-null value (TypeScript helper)
 */
export function assertExists<T>(
  value: T | null | undefined,
  message: string,
  details: Record<string, any> = {},
): T {
  if (value === null || value === undefined) {
    throw new NotFoundError(message, details);
  }
  return value;
}

/**
 * Utility to handle database errors and convert them to appropriate DomeErrors
 * @param error The caught error
 * @param operation Description of the operation that failed
 * @param details Additional context details
 * @returns A DomeError with appropriate type
 */
export function handleDatabaseError(
  error: unknown,
  operation: string,
  details: Record<string, any> = {},
): DomeError {
  const errorObj = error as any;

  // Common database error codes and patterns
  if (errorObj?.code === 'P2025' || errorObj?.message?.includes('not found')) {
    return new NotFoundError(`Resource not found during ${operation}`, details, error as Error);
  }

  if (errorObj?.code === 'P2002' || errorObj?.message?.includes('unique constraint')) {
    return new ConflictError(`Duplicate entry found during ${operation}`, details, error as Error);
  }

  if (errorObj?.code === 'P2003' || errorObj?.message?.includes('foreign key constraint')) {
    return new ValidationError(
      `Foreign key constraint failed during ${operation}`,
      details,
      error as Error,
    );
  }

  return new InternalError(`Database error during ${operation}`, details, error as Error);
}

/**
 * Create a specialized error handler for a specific domain/service
 * @param domain Domain or service name for context
 * @param defaultDetails Default details to include in all errors
 * @returns Object with error helper methods
 */
export function createErrorFactory(domain: string, defaultDetails: Record<string, any> = {}) {
  return {
    validation: (message: string, details?: Record<string, any>, cause?: Error) =>
      new ValidationError(`[${domain}] ${message}`, { ...defaultDetails, ...details }, cause),

    notFound: (message: string, details?: Record<string, any>, cause?: Error) =>
      new NotFoundError(`[${domain}] ${message}`, { ...defaultDetails, ...details }, cause),

    unauthorized: (message: string, details?: Record<string, any>, cause?: Error) =>
      new UnauthorizedError(`[${domain}] ${message}`, { ...defaultDetails, ...details }, cause),

    forbidden: (message: string, details?: Record<string, any>, cause?: Error) =>
      new ForbiddenError(`[${domain}] ${message}`, { ...defaultDetails, ...details }, cause),

    badRequest: (message: string, details?: Record<string, any>, cause?: Error) =>
      new BadRequestError(`[${domain}] ${message}`, { ...defaultDetails, ...details }, cause),

    internal: (message: string, details?: Record<string, any>, cause?: Error) =>
      new InternalError(`[${domain}] ${message}`, { ...defaultDetails, ...details }, cause),

    conflict: (message: string, details?: Record<string, any>, cause?: Error) =>
      new ConflictError(`[${domain}] ${message}`, { ...defaultDetails, ...details }, cause),

    serviceUnavailable: (message: string, details?: Record<string, any>, cause?: Error) =>
      new ServiceUnavailableError(
        `[${domain}] ${message}`,
        { ...defaultDetails, ...details },
        cause,
      ),

    rateLimit: (message: string, details?: Record<string, any>, cause?: Error) =>
      new RateLimitError(`[${domain}] ${message}`, { ...defaultDetails, ...details }, cause),

    wrap: createErrorWrapper(`[${domain}] Operation failed`, defaultDetails),

    assertValid: (condition: boolean, message: string, details: Record<string, any> = {}) =>
      assertValid(condition, `[${domain}] ${message}`, { ...defaultDetails, ...details }),

    assertExists: <T>(
      value: T | null | undefined,
      message: string,
      details: Record<string, any> = {},
    ) => assertExists(value, `[${domain}] ${message}`, { ...defaultDetails, ...details }),

    handleDatabaseError: (error: unknown, operation: string, details: Record<string, any> = {}) =>
      handleDatabaseError(error, `${domain}.${operation}`, { ...defaultDetails, ...details }),
  };
}
