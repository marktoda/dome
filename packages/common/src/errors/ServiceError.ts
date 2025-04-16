import { BaseError } from './BaseError';

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
