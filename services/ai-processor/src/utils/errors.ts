import {
  ValidationError,
  NotFoundError,
  InternalError,
  ConflictError,
  ServiceUnavailableError,
  toDomeError,
  assertValid,
  assertExists,
  createErrorFactory,
} from '@dome/errors';

// Create domain-specific error factory
export const AiProcessorErrors = createErrorFactory('aiprocessor', {
  service: 'ai-processor',
});

/**
 * Specialized error for LLM processing failures
 */
export class LLMProcessingError extends InternalError {
  constructor(message: string, details?: Record<string, any>, cause?: Error) {
    super(
      message,
      {
        code: 'LLM_PROCESSING_ERROR',
        ...details,
      },
      cause,
    );
  }
}

/**
 * Specialized error for content processing failures
 */
export class ContentProcessingError extends InternalError {
  constructor(message: string, details?: Record<string, any>, cause?: Error) {
    super(
      message,
      {
        code: 'CONTENT_PROCESSING_ERROR',
        ...details,
      },
      cause,
    );
  }
}

/**
 * Specialized error for queue operations
 */
export class QueueError extends InternalError {
  constructor(message: string, details?: Record<string, any>, cause?: Error) {
    super(
      message,
      {
        code: 'QUEUE_ERROR',
        ...details,
      },
      cause,
    );
  }
}

/**
 * Determine error type from error object
 * @param error The error object
 * @returns Error type string
 */
export function determineErrorType(error: unknown): string {
  const domeError = toDomeError(error);
  return domeError.code;
}

export { toDomeError, assertValid, assertExists };
