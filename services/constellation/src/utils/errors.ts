import {
  ValidationError,
  NotFoundError,
  InternalError,
  ConflictError,
  ServiceUnavailableError,
  domeAssertValid as assertValid,
  domeAssertExists as assertExists,
  createErrorFactory,
} from '@dome/common';
import { createServiceErrorHandler } from '@dome/common';

// Service name constant for consistency
const SERVICE_NAME = 'constellation';

// Create domain-specific error factory
export const ConstellationErrors = createErrorFactory(SERVICE_NAME, {
  service: SERVICE_NAME,
});

// Create service-specific error handling utilities
export const toDomeError = createServiceErrorHandler(SERVICE_NAME);

/**
 * Specialized error for vectorize operations
 */
export class VectorizeError extends InternalError {
  constructor(message: string, details?: Record<string, any>, cause?: Error) {
    super(
      message,
      {
        code: 'VECTORIZE_ERROR',
        ...details,
      },
      cause,
    );
  }
}

/**
 * Specialized error for embedding operations
 */
export class EmbeddingError extends InternalError {
  constructor(message: string, details?: Record<string, any>, cause?: Error) {
    super(
      message,
      {
        code: 'EMBEDDING_ERROR',
        ...details,
      },
      cause,
    );
  }
}

/**
 * Specialized error for preprocessing operations
 */
export class PreprocessingError extends InternalError {
  constructor(message: string, details?: Record<string, any>, cause?: Error) {
    super(
      message,
      {
        code: 'PREPROCESSING_ERROR',
        ...details,
      },
      cause,
    );
  }
}

// Re-export common errors
export {
  ValidationError,
  NotFoundError,
  ConflictError,
  ServiceUnavailableError,
  assertValid,
  assertExists,
};
