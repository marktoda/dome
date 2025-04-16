import { Context, MiddlewareHandler, Next } from 'hono';
import { ApiResponse } from '@communicator/common';
import { ZodError } from 'zod';
import { formatZodError } from '../models/schemas';
import {
  BaseError,
  ValidationError,
  SchemaValidationError,
  ServiceError,
} from '../errors';

// Re-export AppError as BaseError for backward compatibility
export { BaseError as AppError } from '../errors';
/*
 * Extended error interface with additional properties
 */
export interface ExtendedError {
  code: string;
  message: string;
  requestId?: string;
  details?: Record<string, any>;
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

    if (error instanceof BaseError) {
      // Handle application-specific errors
      const extendedError: ExtendedError = {
        code: error.code,
        message: error.message,
        requestId,
        // Only include details in non-production environments or if they don't contain sensitive info
        ...((!isProduction || error instanceof ValidationError) && error.details && { details: error.details })
      };

      errorResponse = {
        success: false,
        error: extendedError
      };
      status = error.status;
    } else if (error instanceof ZodError) {
      // Handle Zod validation errors
      const formattedErrors = formatZodError(error);
      const schemaError = new SchemaValidationError('Validation error', { errors: formattedErrors });

      const extendedError: ExtendedError = {
        code: schemaError.code,
        message: schemaError.message,
        requestId,
        details: schemaError.details
      };

      errorResponse = {
        success: false,
        error: extendedError
      };
      status = schemaError.status;
    } else {
      // Handle unknown errors
      // In production, use a generic error message to avoid exposing sensitive information
      const errorMessage = isProduction
        ? 'An internal server error occurred'
        : (error instanceof Error ? error.message : 'Unknown error');

      // Create a ServiceError for unknown errors
      const serviceError = new ServiceError(
        isProduction ? errorMessage : `Error processing request: ${errorMessage}`
      );

      const extendedError: ExtendedError = {
        code: serviceError.code,
        message: serviceError.message,
        requestId
      };

      errorResponse = {
        success: false,
        error: extendedError
      };
      status = serviceError.status;
    }

    return c.json(errorResponse, status);
  }
};
