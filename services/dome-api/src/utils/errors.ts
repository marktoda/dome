/**
 * Error handling utilities for the dome API
 */

import { ZodError } from 'zod';
import type { ApiResponse } from '@dome/common';

/**
 * Base API error class
 */
export class ApiError extends Error {
  public statusCode: number;
  public code: string;
  public details?: Record<string, any>;
  public requestId?: string;

  constructor(message: string, statusCode: number, code: string, details?: Record<string, any>) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  /**
   * Convert the error to an API response
   */
  toResponse(): ApiResponse {
    return {
      success: false,
      error: {
        code: this.code,
        message: this.message,
        requestId: this.requestId,
        details: this.details,
      },
    };
  }
}

/**
 * Not found error
 */
export class NotFoundError extends ApiError {
  constructor(message = 'Resource not found', details?: Record<string, any>) {
    super(message, 404, 'NOT_FOUND', details);
  }
}

/**
 * Bad request error
 */
export class BadRequestError extends ApiError {
  constructor(message = 'Bad request', details?: Record<string, any>) {
    super(message, 400, 'BAD_REQUEST', details);
  }
}

/**
 * Validation error
 */
export class ValidationError extends ApiError {
  constructor(message = 'Validation error', details?: Record<string, any>) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

/**
 * Unauthorized error
 */
export class UnauthorizedError extends ApiError {
  constructor(message = 'Unauthorized', details?: Record<string, any>) {
    super(message, 401, 'UNAUTHORIZED', details);
  }
}

/**
 * Forbidden error
 */
export class ForbiddenError extends ApiError {
  constructor(message = 'Forbidden', details?: Record<string, any>) {
    super(message, 403, 'FORBIDDEN', details);
  }
}

/**
 * Internal server error
 */
export class InternalServerError extends ApiError {
  constructor(message = 'Internal server error', details?: Record<string, any>) {
    super(message, 500, 'INTERNAL_SERVER_ERROR', details);
  }
}

/**
 * Not implemented error
 */
export class NotImplementedError extends ApiError {
  constructor(message = 'Not implemented', details?: Record<string, any>) {
    super(message, 501, 'NOT_IMPLEMENTED', details);
  }
}

/**
 * Format Zod validation errors
 */
export function formatZodError(error: ZodError): Record<string, any> {
  return {
    issues: error.errors.map(err => ({
      path: err.path.join('.'),
      message: err.message,
    })),
  };
}

/**
 * Error handler middleware
 */
export function errorHandler(err: Error): ApiResponse {
  console.error('Error:', err);

  if (err instanceof ApiError) {
    return err.toResponse();
  }

  if (err instanceof ZodError) {
    const validationError = new ValidationError('Validation error', formatZodError(err));
    return validationError.toResponse();
  }

  const internalError = new InternalServerError(err.message);
  return internalError.toResponse();
}
