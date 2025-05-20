import {
  ValidationError,
  NotFoundError,
  ConflictError,
  ServiceUnavailableError,
  UnauthorizedError,
  createErrorFactory,
  domeAssertExists as assertExists,
} from '@dome/common';
import {
  createServiceErrorHandler,
  createEnhancedAssertValid,
  createServiceErrorMiddleware,
} from '@dome/common';

// Service name constant for consistency
const SERVICE_NAME = 'chat';

// Create domain-specific error factory
export const ChatErrors = createErrorFactory(SERVICE_NAME, {
  service: SERVICE_NAME,
});

// Create service-specific error handling utilities
export const toDomeError = createServiceErrorHandler(SERVICE_NAME);
export const assertValid = createEnhancedAssertValid();
export const createErrorMiddleware = createServiceErrorMiddleware(SERVICE_NAME);

/**
 * RAG specific error
 */
export class RAGError extends ServiceUnavailableError {
  constructor(message: string, details?: Record<string, any>, cause?: Error) {
    super(
      message,
      {
        code: 'RAG_ERROR',
        ...details,
      },
      cause,
    );
  }
}

/**
 * LLM related error
 */
export class LLMError extends ServiceUnavailableError {
  constructor(message: string, details?: Record<string, any>, cause?: Error) {
    super(
      message,
      {
        code: 'LLM_ERROR',
        ...details,
      },
      cause,
    );
  }
}

/**
 * Node processing error
 */
export class NodeError extends ServiceUnavailableError {
  constructor(message: string, details?: Record<string, any>, cause?: Error) {
    super(
      message,
      {
        code: 'NODE_ERROR',
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
  UnauthorizedError,
  assertExists,
  createErrorFactory,
};
