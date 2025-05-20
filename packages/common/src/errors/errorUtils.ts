/**
 * Error utilities that work with domeErrors module
 */
import { getLogger } from '@dome/common';

/**
 * Enhanced toDomeError function with service-specific context
 *
 * @param error Any error or exception
 * @param serviceName Name of the service for context
 * @param defaultMessage Message to use if error is not an Error instance
 * @param defaultDetails Details to include if none available
 * @returns A DomeError instance
 */
export function createServiceErrorHandler(serviceName: string) {
  // Import locally at runtime to avoid potential circular dependencies
  const { toDomeError: baseToDomeError } = require('./domeErrors.js');

  return function toDomeError(
    error: unknown,
    defaultMessage = `An unexpected error occurred in ${serviceName} service`,
    defaultDetails: Record<string, any> = {},
  ) {
    return baseToDomeError(error, defaultMessage, {
      service: serviceName,
      ...defaultDetails,
    });
  };
}

/**
 * Enhanced version of assertValid that explicitly converts string expressions to boolean
 */
export function createEnhancedAssertValid() {
  // Import locally at runtime to avoid potential circular dependencies
  const { assertValid: originalAssertValid } = require('./domeErrors.js');

  return function assertValid(
    condition: string | boolean | undefined | null,
    message: string,
    details: Record<string, any> = {},
  ): void {
    // Explicitly convert string expressions to boolean
    const boolCondition =
      condition !== null &&
      condition !== undefined &&
      condition !== '' &&
      (typeof condition === 'boolean' ? condition : true);

    originalAssertValid(!!boolCondition, message, details);
  };
}

/**
 * Create error middleware for Hono that's service-aware
 */
export function createServiceErrorMiddleware(serviceName: string) {
  return function createErrorMiddleware(
    options: {
      errorMapper?: (err: unknown) => any;
    } = {},
  ) {
    return async (c: any, next: any) => {
      try {
        await next();
      } catch (err) {
        // Get logger from context or fallback
        const logger = c.get?.('logger') || getLogger();

        // Get service-specific error handler
        const toDomeError = createServiceErrorHandler(serviceName);

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
          service: serviceName,
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
  };
}
