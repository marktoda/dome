import {
  ValidationError,
  NotFoundError,
  ConflictError,
  ServiceUnavailableError,
  UnauthorizedError,
  toDomeError as baseToDomeError,
  assertValid as originalAssertValid,
  assertExists as originalAssertExists,
  createErrorFactory,
  errorHandler,
} from '@dome/errors';
import { getLogger as getDomeLogger } from '@dome/logging';

// Create domain-specific error factory
export const ChatErrors = createErrorFactory('chat', {
  service: 'chat',
});

/**
 * RAG specific error
 */
export class RAGError extends ServiceUnavailableError {
  constructor(message: string, details?: Record<string, any>, cause?: Error) {
    super(message, {
      code: 'RAG_ERROR',
      ...details,
    }, cause);
  }
}

/**
 * LLM related error
 */
export class LLMError extends ServiceUnavailableError {
  constructor(message: string, details?: Record<string, any>, cause?: Error) {
    super(message, {
      code: 'LLM_ERROR',
      ...details,
    }, cause);
  }
}

/**
 * Node processing error
 */
export class NodeError extends ServiceUnavailableError {
  constructor(message: string, details?: Record<string, any>, cause?: Error) {
    super(message, {
      code: 'NODE_ERROR',
      ...details,
    }, cause);
  }
}

/**
 * Enhanced version of assertValid that explicitly converts string expressions to boolean
 * @param condition Condition to check, can handle string expressions
 * @param message Error message if condition is false
 * @param details Additional error details
 */
export function assertValid(
  condition: string | boolean | undefined | null,
  message: string,
  details: Record<string, any> = {}
): void {
  // Explicitly convert string expressions to boolean
  const boolCondition = condition !== null && 
                       condition !== undefined && 
                       condition !== '' && 
                       (typeof condition === 'boolean' ? condition : true);
  
  originalAssertValid(!!boolCondition, message, details);
}

/**
 * Enhanced toDomeError function with Chat-specific context
 * @param error Any error or exception
 * @param defaultMessage Message to use if error is not an Error instance
 * @param defaultDetails Details to include if none available
 * @returns A DomeError instance
 */
export function toDomeError(
  error: unknown, 
  defaultMessage = 'An unexpected error occurred in Chat service',
  defaultDetails: Record<string, any> = {}
) {
  return baseToDomeError(error, defaultMessage, {
    service: 'chat',
    ...defaultDetails
  });
}

/**
 * Create error middleware for Hono that's compatible with the Chat service
 */
export function createErrorMiddleware(options: {
  errorMapper?: (err: unknown) => any;
} = {}) {
  return async (c: any, next: any) => {
    try {
      await next();
    } catch (err) {
      // Get logger from context or fallback
      const logger = c.get?.('logger') || getDomeLogger();

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
          details: error.details
        }
      });
    }
  };
}

export {
  ValidationError,
  NotFoundError,
  ConflictError,
  ServiceUnavailableError,
  UnauthorizedError,
  originalAssertExists as assertExists,
  createErrorFactory
};