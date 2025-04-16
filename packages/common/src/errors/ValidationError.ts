import { BaseError } from './BaseError';

/**
 * Error class for validation errors
 */
export class ValidationError extends BaseError {
  /**
   * Creates a new ValidationError
   * @param message Error message
   * @param details Additional error details
   */
  constructor(message: string, details?: Record<string, any>) {
    super(message, 'VALIDATION_ERROR', 400, details);
  }
}

/**
 * Error class for schema validation errors
 */
export class SchemaValidationError extends ValidationError {
  /**
   * Creates a new SchemaValidationError
   * @param message Error message
   * @param details Additional error details
   */
  constructor(message: string, details?: Record<string, any>) {
    super(message, { ...details, errorType: 'schema_validation' });
    this.code = 'SCHEMA_VALIDATION_ERROR';
  }
}

/**
 * Error class for message format validation errors
 */
export class MessageFormatError extends ValidationError {
  /**
   * Creates a new MessageFormatError
   * @param message Error message
   * @param details Additional error details
   */
  constructor(message: string, details?: Record<string, any>) {
    super(message, { ...details, errorType: 'message_format' });
    this.code = 'MESSAGE_FORMAT_ERROR';
  }
}

/**
 * Error class for batch validation errors
 */
export class BatchValidationError extends ValidationError {
  /**
   * Creates a new BatchValidationError
   * @param message Error message
   * @param details Additional error details
   */
  constructor(message: string, details?: Record<string, any>) {
    super(message, { ...details, errorType: 'batch_validation' });
    this.code = 'BATCH_VALIDATION_ERROR';
  }
}
