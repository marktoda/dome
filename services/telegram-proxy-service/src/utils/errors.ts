import type { Request, Response, NextFunction } from 'express';
import { logger, logError } from './logger';
import { SERVER } from '../config';

/**
 * Base API error class
 * Provides common functionality for all API errors
 */
export class ApiError extends Error {
  public statusCode: number;
  public code: string;
  public details?: Record<string, any>;
  public isOperational: boolean;

  constructor(
    message: string,
    statusCode: number,
    code: string,
    details?: Record<string, any>,
    isOperational = true,
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = isOperational;
    this.name = this.constructor.name;

    // Use Error.captureStackTrace if available (Node.js environment)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Base application error class (legacy)
 * @deprecated Use ApiError instead
 */
export class AppError extends Error {
  public statusCode: number;
  public isOperational: boolean;

  constructor(message: string, statusCode: number, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.name = this.constructor.name;

    // Use Error.captureStackTrace if available (Node.js environment)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Validation error
 * Used for input validation failures
 */
export class ValidationError extends ApiError {
  constructor(message = 'Validation failed', details?: Record<string, any>) {
    super(message, 400, 'VALIDATION_ERROR', details, true);
  }
}

/**
 * Bad request error (legacy)
 * @deprecated Use ValidationError instead
 */
export class BadRequestError extends AppError {
  constructor(message = 'Bad request') {
    super(message, 400);
  }
}

/**
 * Authentication error
 * Used for authentication failures
 */
export class AuthenticationError extends ApiError {
  constructor(message = 'Authentication failed', details?: Record<string, any>) {
    super(message, 401, 'AUTHENTICATION_ERROR', details, true);
  }
}

/**
 * Authorization error
 * Used for authorization failures
 */
export class AuthorizationError extends ApiError {
  constructor(message = 'Not authorized', details?: Record<string, any>) {
    super(message, 403, 'AUTHORIZATION_ERROR', details, true);
  }
}

/**
 * Not found error
 * Used when a requested resource is not found
 */
export class NotFoundError extends ApiError {
  constructor(message = 'Resource not found', details?: Record<string, any>) {
    super(message, 404, 'NOT_FOUND', details, true);
  }
}

/**
 * Conflict error
 * Used when there is a conflict with the current state of the resource
 */
export class ConflictError extends ApiError {
  constructor(message = 'Resource conflict', details?: Record<string, any>) {
    super(message, 409, 'CONFLICT', details, true);
  }
}

/**
 * Rate limit error
 * Used when a client has sent too many requests
 */
export class RateLimitError extends ApiError {
  public retryAfter?: number;

  constructor(message = 'Too many requests', retryAfter?: number, details?: Record<string, any>) {
    super(message, 429, 'RATE_LIMIT', details, true);
    this.retryAfter = retryAfter;
  }
}

/**
 * Telegram API error
 * Used for errors from the Telegram API
 */
export class TelegramError extends ApiError {
  constructor(message = 'Telegram API error', details?: Record<string, any>, statusCode = 502) {
    super(message, statusCode, 'TELEGRAM_ERROR', details, true);
  }
}

/**
 * Telegram API error (legacy)
 * @deprecated Use TelegramError instead
 */
export class TelegramApiError extends AppError {
  constructor(message = 'Telegram API error', statusCode = 500) {
    super(message, statusCode, true);
  }
}

/**
 * Redis error
 * Used for errors from Redis
 */
export class RedisError extends ApiError {
  constructor(message = 'Redis error', details?: Record<string, any>) {
    super(message, 500, 'REDIS_ERROR', details, true);
  }
}

/**
 * Session error (legacy)
 * @deprecated Use ApiError with appropriate details
 */
export class SessionError extends AppError {
  constructor(message = 'Session error', statusCode = 500) {
    super(message, statusCode, true);
  }
}

/**
 * Client pool error (legacy)
 * @deprecated Use ApiError with appropriate details
 */
export class ClientPoolError extends AppError {
  constructor(message = 'Client pool error', statusCode = 500) {
    super(message, statusCode, true);
  }
}

/**
 * Internal server error
 * Used for unexpected server errors
 */
export class InternalServerError extends ApiError {
  constructor(message = 'Internal server error', details?: Record<string, any>) {
    super(message, 500, 'INTERNAL_SERVER_ERROR', details, false);
  }
}

/**
 * Convert an error to an API response
 * @param error The error to convert
 * @param includeStack Whether to include the stack trace
 * @returns An object suitable for API responses
 */
export const errorToResponse = (error: Error, includeStack = false): Record<string, any> => {
  // If it's an ApiError, use its properties
  if (error instanceof ApiError) {
    const response: Record<string, any> = {
      success: false,
      error: {
        code: error.code,
        message: error.message,
      },
    };

    // Add details if available
    if (error.details && Object.keys(error.details).length > 0) {
      response.error.details = error.details;
    }

    // Add retry-after for rate limit errors
    if (error instanceof RateLimitError && error.retryAfter) {
      response.error.retryAfter = error.retryAfter;
    }

    // Add stack trace in development
    if (includeStack && error.stack) {
      response.error.stack = error.stack;
    }

    return response;
  }

  // If it's an AppError (legacy), convert it
  if (error instanceof AppError) {
    const response: Record<string, any> = {
      success: false,
      error: {
        code: error.name,
        message: error.message,
      },
    };

    // Add retry-after for rate limit errors
    if (error instanceof RateLimitError && (error as any).retryAfter) {
      response.error.retryAfter = (error as any).retryAfter;
    }

    // Add stack trace in development
    if (includeStack && error.stack) {
      response.error.stack = error.stack;
    }

    return response;
  }

  // For non-ApiErrors, create a generic response
  const response: Record<string, any> = {
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: SERVER.IS_PRODUCTION
        ? 'An unexpected error occurred'
        : error.message || 'An unexpected error occurred',
    },
  };

  // Add stack trace in development
  if (includeStack && error.stack) {
    response.error.stack = error.stack;
  }

  return response;
};

/**
 * Error handler middleware
 * Handles all errors in the application
 */
export const errorHandler = (err: Error, req: Request, res: Response, next: NextFunction): void => {
  // Log the error
  logError(err, req);

  // Set default status code
  let statusCode = 500;

  // If it's an ApiError, use its status code
  if (err instanceof ApiError) {
    statusCode = err.statusCode;
  }
  // If it's an AppError (legacy), use its status code
  else if (err instanceof AppError) {
    statusCode = err.statusCode;
  }

  // Convert error to response
  const response = errorToResponse(err, !SERVER.IS_PRODUCTION);

  // Send response
  res.status(statusCode).json(response);
};

/**
 * Async handler wrapper
 * Catches errors in async route handlers and passes them to the error handler
 */
export const asyncHandler =
  (fn: Function) =>
  (req: Request, res: Response, next: NextFunction): Promise<any> =>
    Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Not found handler
 * Handles 404 errors for routes that don't exist
 */
export const notFoundHandler = (req: Request, res: Response, next: NextFunction): void => {
  next(new NotFoundError(`Route not found: ${req.method} ${req.originalUrl}`));
};
