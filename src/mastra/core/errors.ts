/**
 * Common error types and utilities for the Dome system
 */

/**
 * Base error class for Dome-specific errors
 */
export class DomeError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: any
  ) {
    super(message);
    this.name = 'DomeError';
  }
}

/**
 * Error thrown when a note is not found
 */
export class NoteNotFoundError extends DomeError {
  constructor(path: string) {
    super(`Note not found: ${path}`, 'NOTE_NOT_FOUND', { path });
    this.name = 'NoteNotFoundError';
  }
}

/**
 * Error thrown when context validation fails
 */
export class ContextValidationError extends DomeError {
  constructor(message: string, details?: any) {
    super(message, 'CONTEXT_VALIDATION_ERROR', details);
    this.name = 'ContextValidationError';
  }
}

/**
 * Error thrown when file operations fail
 */
export class FileOperationError extends DomeError {
  constructor(operation: string, path: string, originalError?: Error) {
    super(
      `File operation '${operation}' failed for: ${path}`,
      'FILE_OPERATION_ERROR',
      { operation, path, originalError: originalError?.message }
    );
    this.name = 'FileOperationError';
  }
}

/**
 * Error thrown when indexing operations fail
 */
export class IndexingError extends DomeError {
  constructor(message: string, details?: any) {
    super(message, 'INDEXING_ERROR', details);
    this.name = 'IndexingError';
  }
}

/**
 * Safely extract error message from unknown error type
 * @param error - Any error type
 * @returns Error message string
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return String(error.message);
  }
  return 'Unknown error';
}

/**
 * Check if error is a specific Node.js error code
 * @param error - Error to check
 * @param code - Node error code (e.g., 'ENOENT')
 */
export function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === code
  );
}

/**
 * Create a standardized error response
 */
export interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: any;
  };
}

/**
 * Create an error response object
 */
export function createErrorResponse(error: unknown): ErrorResponse {
  if (error instanceof DomeError) {
    return {
      success: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    };
  }
  
  return {
    success: false,
    error: {
      code: 'UNKNOWN_ERROR',
      message: getErrorMessage(error),
    },
  };
}