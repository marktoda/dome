import { BaseError } from './BaseError';
/**
 * Error class for validation errors
 */
export declare class ValidationError extends BaseError {
  /**
   * Creates a new ValidationError
   * @param message Error message
   * @param details Additional error details
   */
  constructor(message: string, details?: Record<string, any>);
}
/**
 * Error class for schema validation errors
 */
export declare class SchemaValidationError extends ValidationError {
  /**
   * Creates a new SchemaValidationError
   * @param message Error message
   * @param details Additional error details
   */
  constructor(message: string, details?: Record<string, any>);
}
/**
 * Error class for message format validation errors
 */
export declare class MessageFormatError extends ValidationError {
  /**
   * Creates a new MessageFormatError
   * @param message Error message
   * @param details Additional error details
   */
  constructor(message: string, details?: Record<string, any>);
}
/**
 * Error class for batch validation errors
 */
export declare class BatchValidationError extends ValidationError {
  /**
   * Creates a new BatchValidationError
   * @param message Error message
   * @param details Additional error details
   */
  constructor(message: string, details?: Record<string, any>);
}
