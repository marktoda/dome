import { Context, MiddlewareHandler, Next } from 'hono';
import { ApiResponse } from '@communicator/common';
import { ZodError } from 'zod';
import { formatZodError } from '../models/schemas';
import { ExtendedError, createValidationErrorResponse, createServerErrorResponse } from '../utils/responseUtils';

/**
 * Custom error class for application-specific errors
 */
export class AppError extends Error {
  code: string;
  status: number;
  details?: Record<string, any>;

  /**
   * Creates a new AppError
   * @param message Error message
   * @param code Error code
   * @param status HTTP status code
   * @param details Additional error details
   */
  constructor(message: string, code: string, status: number = 500, details?: Record<string, any>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Creates a validation error
 * @param message Error message
 * @param details Additional error details
 * @returns AppError instance
 */
export function createValidationError(message: string, details?: Record<string, any>): AppError {
  return new AppError(message, 'VALIDATION_ERROR', 400, details);
}

/**
 * Creates a server error
 * @param message Error message
 * @param details Additional error details
 * @returns AppError instance
 */
export function createServerError(message: string, details?: Record<string, any>): AppError {
  return new AppError(message, 'SERVER_ERROR', 500, details);
}

/**
 * Creates a queue error
 * @param message Error message
 * @param details Additional error details
 * @returns AppError instance
 */
export function createQueueError(message: string, details?: Record<string, any>): AppError {
  return new AppError(message, 'QUEUE_ERROR', 500, details);
}

/**
 * Error handling middleware for Hono
 * Catches errors and formats them into standardized responses
 */
export const errorMiddleware: MiddlewareHandler = async (c: Context, next: Next) => {
  try {
    await next();
  } catch (error) {
    // Log the error with request ID
    const requestId = c.get('requestId') || 'unknown';
    console.error(`Error processing request [${requestId}]:`, error instanceof Error ? error : {});

    let errorResponse: ApiResponse;
    let status = 500;

    const isProduction = c.env.ENVIRONMENT === 'production';

    if (error instanceof AppError) {
      // Handle application-specific errors
      const extendedError: ExtendedError = {
        code: error.code,
        message: error.message,
        requestId,
        // Only include details in non-production environments or if they don't contain sensitive info
        ...((!isProduction || error.code === 'VALIDATION_ERROR') && error.details && { details: error.details })
      };

      errorResponse = {
        success: false,
        error: extendedError
      };
      status = error.status;
    } else if (error instanceof ZodError) {
      // Handle Zod validation errors
      const formattedErrors = formatZodError(error);
      const { body, status: responseStatus } = createValidationErrorResponse('Validation error', { errors: formattedErrors });
      return c.json(body, responseStatus);
    } else {
      // Handle unknown errors
      // In production, use a generic error message to avoid exposing sensitive information
      const errorMessage = isProduction
        ? 'An internal server error occurred'
        : (error instanceof Error ? error.message : 'Unknown error');

      const { body, status: responseStatus } = createServerErrorResponse(
        isProduction ? errorMessage : `Error processing request: ${errorMessage}`
      );
      return c.json(body, responseStatus);
    }

    return c.json(errorResponse, status);
  }
};
