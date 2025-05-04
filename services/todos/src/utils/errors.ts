import { getLogger } from '@dome/common';

const logger = getLogger();

/**
 * Base error class for the Todos service
 */
export class DomeError extends Error {
  code: string;
  statusCode: number;
  details: Record<string, any>;

  constructor(
    message: string,
    code = 'INTERNAL_ERROR',
    statusCode = 500,
    details: Record<string, any> = {},
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.details = {
      service: 'todos',
      ...details,
    };
  }
}

/**
 * Error for validation failures
 */
export class ValidationError extends DomeError {
  constructor(message: string, details: Record<string, any> = {}) {
    super(message, 'VALIDATION_ERROR', 400, details);
    this.name = 'ValidationError';
  }
}

/**
 * Error for resource not found
 */
export class NotFoundError extends DomeError {
  constructor(message: string, details: Record<string, any> = {}) {
    super(message, 'NOT_FOUND', 404, details);
    this.name = 'NotFoundError';
  }
}

/**
 * Error for conflict situations
 */
export class ConflictError extends DomeError {
  constructor(message: string, details: Record<string, any> = {}) {
    super(message, 'CONFLICT', 409, details);
    this.name = 'ConflictError';
  }
}

/**
 * Error for database operations
 */
export class DatabaseError extends DomeError {
  constructor(message: string, details: Record<string, any> = {}, cause?: Error) {
    super(message, 'DATABASE_ERROR', 500, details);
    this.name = 'DatabaseError';
    if (cause) (this as any).cause = cause;
  }
}

/**
 * Error for queue processing operations
 */
export class QueueProcessingError extends DomeError {
  constructor(message: string, details: Record<string, any> = {}, cause?: Error) {
    super(message, 'QUEUE_PROCESSING_ERROR', 500, details);
    this.name = 'QueueProcessingError';
    if (cause) (this as any).cause = cause;
  }
}

/**
 * Assert that a condition is true
 */
export function assertValid(
  condition: any,
  message: string,
  details: Record<string, any> = {},
): void {
  if (!condition) {
    throw new ValidationError(message, details);
  }
}

/**
 * Assert that a value exists
 */
export function assertExists<T>(
  value: T | null | undefined,
  message: string,
  details: Record<string, any> = {},
): asserts value is T {
  if (value === null || value === undefined) {
    throw new NotFoundError(message, details);
  }
}

/**
 * Convert any error to a DomeError
 */
export function toDomeError(
  error: unknown,
  defaultMessage = 'An unexpected error occurred in Todos service',
  defaultDetails: Record<string, any> = {},
): DomeError {
  if (error instanceof DomeError) {
    return error;
  }

  const message = error instanceof Error ? error.message : defaultMessage;
  const errorDetails = {
    ...defaultDetails,
    originalError: error instanceof Error ? error.message : String(error),
  };

  // Create appropriate error type based on available information
  if (error instanceof Error) {
    if (error.message.includes('not found') || error.message.includes('does not exist')) {
      return new NotFoundError(message, errorDetails);
    } else if (error.message.includes('invalid') || error.message.includes('validation')) {
      return new ValidationError(message, errorDetails);
    } else if (error.message.includes('conflict') || error.message.includes('duplicate')) {
      return new ConflictError(message, errorDetails);
    } else if (error.message.includes('database') || error.message.includes('sql')) {
      return new DatabaseError(message, errorDetails, error);
    }
  }

  // Default to generic DomeError
  return new DomeError(message, 'INTERNAL_ERROR', 500, errorDetails);
}

/**
 * Create error middleware for Hono
 */
export function createErrorMiddleware(
  options: {
    errorMapper?: (err: unknown) => any;
  } = {},
) {
  return async (c: any, next: any) => {
    try {
      await next();
    } catch (err) {
      // Convert error to DomeError
      const error = options.errorMapper
        ? options.errorMapper(err)
        : toDomeError(err, 'Unhandled request error');

      // Log error
      logger.error({
        event: 'error_handled',
        error,
        path: c.req?.path,
        method: c.req?.method,
      });

      // Set response status
      c.status(error.statusCode || 500);

      // Create response body
      return c.json({
        success: false,
        error: {
          code: error.code || 'INTERNAL_ERROR',
          message: error.message || 'An unexpected error occurred',
          details: error.details,
        },
      });
    }
  };
}

// Export common error codes
export enum TodosErrorCode {
  DATABASE_ERROR = 'DATABASE_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  QUEUE_ERROR = 'QUEUE_ERROR',
}
