import { BaseError } from './BaseError.js';

/**
 * Error class for service-related errors
 */
export class ServiceError extends BaseError {
  /**
   * Creates a new ServiceError
   * @param message Error message
   * @param details Additional error details
   */
  constructor(message: string, details?: Record<string, any>) {
    super(message, 'SERVICE_ERROR', 500, details);
  }
}

/**
 * Error class for queue-related errors
 */
export class QueueError extends ServiceError {
  /**
   * Creates a new QueueError
   * @param message Error message
   * @param details Additional error details
   */
  constructor(message: string, details?: Record<string, any>) {
    super(message, { ...details, errorType: 'queue_error' });
    this.code = 'QUEUE_ERROR';
  }
}

/**
 * Error class for message processing errors
 */
export class MessageProcessingError extends ServiceError {
  /**
   * Creates a new MessageProcessingError
   * @param message Error message
   * @param details Additional error details
   */
  constructor(message: string, details?: Record<string, any>) {
    super(message, { ...details, errorType: 'message_processing' });
    this.code = 'MESSAGE_PROCESSING_ERROR';
  }
}

/**
 * Error class for rate limit errors
 */
export class RateLimitError extends ServiceError {
  /**
   * Creates a new RateLimitError
   * @param message Error message
   * @param details Additional error details
   */
  constructor(message: string, details?: Record<string, any>) {
    super(message, { ...details, errorType: 'rate_limit' });
    this.code = 'RATE_LIMIT_ERROR';
    this.status = 429; // Too Many Requests
  }
}

/**
 * Error class for resource not found errors
 */
export class NotFoundError extends ServiceError {
  /**
   * Creates a new NotFoundError
   * @param message Error message
   * @param details Additional error details
   */
  constructor(message: string, details?: Record<string, any>) {
    super(message, { ...details, errorType: 'not_found' });
    this.code = 'NOT_FOUND_ERROR';
    this.status = 404; // Not Found
  }
}

/**
 * Error class for unauthorized access
 */
export class UnauthorizedError extends ServiceError {
  /**
   * Creates a new UnauthorizedError
   * @param message Error message
   * @param details Additional error details
   */
  constructor(message: string = 'Unauthorized', details?: Record<string, any>) {
    super(message, { ...details, errorType: 'unauthorized' });
    this.code = 'UNAUTHORIZED_ERROR';
    this.status = 401; // Unauthorized
  }
}

/**
 * Error class for forbidden access
 */
export class ForbiddenError extends ServiceError {
  /**
   * Creates a new ForbiddenError
   * @param message Error message
   * @param details Additional error details
   */
  constructor(message: string = 'Forbidden', details?: Record<string, any>) {
    super(message, { ...details, errorType: 'forbidden' });
    this.code = 'FORBIDDEN_ERROR';
    this.status = 403; // Forbidden
  }
}

/**
 * Error class for not implemented functionality
 */
export class NotImplementedError extends ServiceError {
  /**
   * Creates a new NotImplementedError
   * @param message Error message
   * @param details Additional error details
   */
  constructor(message: string = 'Not implemented', details?: Record<string, any>) {
    super(message, { ...details, errorType: 'not_implemented' });
    this.code = 'NOT_IMPLEMENTED_ERROR';
    this.status = 501; // Not Implemented
  }
}
