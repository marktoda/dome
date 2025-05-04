import {
  createErrorFactory as originalCreateErrorFactory,
  DomeError,
  toDomeError as baseToDomeError,
} from '@dome/errors';
import { getLogger } from '../logging';

/**
 * Creates a service-specific error factory with default context
 *
 * @param serviceName Name of the service for context and codes
 * @param defaultContext Default context to include with all errors
 * @returns An error factory function bound to the service
 */
export function createServiceErrorFactory(
  serviceName: string,
  defaultContext: Record<string, any> = {},
) {
  return originalCreateErrorFactory(serviceName, {
    service: serviceName,
    ...defaultContext,
  });
}

/**
 * Enhanced toDomeError function with service-specific context
 *
 * @param error Any error or exception
 * @param serviceName Name of the service for context
 * @param defaultMessage Message to use if error is not an Error instance
 * @param defaultDetails Details to include if none available
 * @returns A DomeError instance
 */
export function toDomeError(
  error: unknown,
  serviceName: string,
  defaultMessage = `An unexpected error occurred in ${serviceName} service`,
  defaultDetails: Record<string, any> = {},
) {
  return baseToDomeError(error, defaultMessage, {
    service: serviceName,
    ...defaultDetails,
  });
}

/**
 * Enhanced version of assertValid that explicitly converts string expressions to boolean
 *
 * @param condition Condition to check, can handle string expressions
 * @param message Error message if condition is false
 * @param details Additional error details
 */
export function assertValid(
  condition: string | boolean | undefined | null,
  message: string,
  details: Record<string, any> = {},
): void {
  // Import dynamically to avoid circular dependencies
  const { assertValid: originalAssertValid } = require('@dome/errors');

  // Explicitly convert string expressions to boolean
  const boolCondition =
    condition !== null &&
    condition !== undefined &&
    condition !== '' &&
    (typeof condition === 'boolean' ? condition : true);

  originalAssertValid(!!boolCondition, message, details);
}

/**
 * Create error middleware for Hono that's service-aware
 *
 * @param options Configuration options for the middleware
 * @param options.serviceName Name of the service for error context
 * @param options.errorMapper Optional function to map errors before handling
 */
export function createErrorMiddleware(
  options: {
    serviceName: string;
    errorMapper?: (err: unknown) => any;
  } = { serviceName: 'unknown' },
) {
  return async (c: any, next: any) => {
    try {
      await next();
    } catch (err) {
      // Get logger from context or fallback
      const logger = c.get?.('logger') || getLogger();

      // Convert error to DomeError
      const error = options.errorMapper
        ? options.errorMapper(err)
        : toDomeError(err, options.serviceName, 'Unhandled request error');

      // Log error
      logger.error({
        event: 'error_handled',
        error,
        path: c.req?.path,
        method: c.req?.method,
        service: options.serviceName,
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

/**
 * Re-export from @dome/errors for convenience
 */
export { DomeError };
