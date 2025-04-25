// Import Hono types
import type { Context, Next } from 'hono';

// Error hierarchy
export class DomeError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details?: Record<string, any>;
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
  }

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
}

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

// Error middleware
export function getLogger() {
  return {
    error: console.error,
    warn: console.warn,
    info: console.info,
    debug: console.debug,
  };
}

export function errorHandler() {
  return async (c: Context, next: Next) => {
    try {
      await next();
    } catch (err) {
      const logger = c.get('logger') || getLogger();

      const error =
        err instanceof DomeError
          ? err
          : new InternalError(
              'An unexpected error occurred',
              {},
              err instanceof Error ? err : undefined,
            );

      logger.error({
        event: 'error_handled',
        error: error.toJSON(),
      });

      c.status(error.statusCode);
      return c.json({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      });
    }
  };
}
