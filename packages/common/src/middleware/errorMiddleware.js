import { ZodError } from 'zod';
import { BaseError, ValidationError, SchemaValidationError, ServiceError } from '../errors';
/**
 * Error handling middleware for Hono
 * Catches errors and formats them into standardized responses
 *
 * @param formatZodError Optional function to format Zod validation errors
 * @returns Middleware handler
 */
export function createErrorMiddleware(formatZodError) {
  return async (c, next) => {
    try {
      await next();
    } catch (error) {
      // Log the error with request ID
      const requestId = c.get('requestId') || 'unknown';
      console.error(
        `Error processing request [${requestId}]:`,
        error instanceof Error ? error : {},
      );
      let errorResponse;
      let status = 500;
      const isProduction = c.env && c.env.ENVIRONMENT === 'production';
      if (error instanceof BaseError) {
        // Handle application-specific errors
        const extendedError = {
          code: error.code,
          message: error.message,
          requestId,
          // Only include details in non-production environments or if they don't contain sensitive info
          ...((!isProduction || error instanceof ValidationError) &&
            error.details && { details: error.details }),
        };
        errorResponse = {
          success: false,
          error: extendedError,
        };
        status = error.status;
      } else if (error instanceof ZodError && formatZodError) {
        // Handle Zod validation errors
        const formattedErrors = formatZodError(error);
        const schemaError = new SchemaValidationError('Validation error', {
          errors: formattedErrors,
        });
        const extendedError = {
          code: schemaError.code,
          message: schemaError.message,
          requestId,
          details: schemaError.details,
        };
        errorResponse = {
          success: false,
          error: extendedError,
        };
        status = schemaError.status;
      } else {
        // Handle unknown errors
        // In production, use a generic error message to avoid exposing sensitive information
        const errorMessage = isProduction
          ? 'An internal server error occurred'
          : error instanceof Error
          ? error.message
          : 'Unknown error';
        // Create a ServiceError for unknown errors
        const serviceError = new ServiceError(
          isProduction ? errorMessage : `Error processing request: ${errorMessage}`,
        );
        const extendedError = {
          code: serviceError.code,
          message: serviceError.message,
          requestId,
        };
        errorResponse = {
          success: false,
          error: extendedError,
        };
        status = serviceError.status;
      }
      return c.json(errorResponse, status);
    }
  };
}
//# sourceMappingURL=errorMiddleware.js.map
