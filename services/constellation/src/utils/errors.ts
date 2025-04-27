import {
  ValidationError,
  NotFoundError,
  InternalError,
  ConflictError,
  ServiceUnavailableError,
  toDomeError as baseToDomeError,
  assertValid,
  assertExists,
  createErrorFactory,
} from '@dome/errors';

// Create domain-specific error factory
export const ConstellationErrors = createErrorFactory('constellation', {
  service: 'constellation',
});

/**
 * Specialized error for vectorize operations
 */
export class VectorizeError extends InternalError {
  constructor(message: string, details?: Record<string, any>, cause?: Error) {
    super(message, {
      code: 'VECTORIZE_ERROR',
      ...details,
    }, cause);
  }
}

/**
 * Specialized error for embedding operations
 */
export class EmbeddingError extends InternalError {
  constructor(message: string, details?: Record<string, any>, cause?: Error) {
    super(message, {
      code: 'EMBEDDING_ERROR',
      ...details,
    }, cause);
  }
}

/**
 * Specialized error for preprocessing operations
 */
export class PreprocessingError extends InternalError {
  constructor(message: string, details?: Record<string, any>, cause?: Error) {
    super(message, {
      code: 'PREPROCESSING_ERROR',
      ...details,
    }, cause);
  }
}

/**
 * Enhanced toDomeError function with Constellation-specific context
 * @param error Any error or exception
 * @param defaultMessage Message to use if error is not an Error instance
 * @param defaultDetails Details to include if none available
 * @returns A DomeError instance
 */
export function toDomeError(
  error: unknown, 
  defaultMessage = 'An unexpected error occurred in Constellation service',
  defaultDetails: Record<string, any> = {}
) {
  return baseToDomeError(error, defaultMessage, {
    service: 'constellation',
    ...defaultDetails
  });
}

export { ValidationError, NotFoundError, ConflictError, ServiceUnavailableError, assertValid, assertExists };