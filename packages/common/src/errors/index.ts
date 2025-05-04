/**
 * Error module for the common package
 * Exports all error classes and utility functions
 */

// Base error class
export { BaseError } from './BaseError';

// Validation errors
import {
  ValidationError,
  SchemaValidationError,
  MessageFormatError,
  BatchValidationError,
} from './ValidationError';

export { ValidationError, SchemaValidationError, MessageFormatError, BatchValidationError };

// Service errors
import {
  ServiceError,
  QueueError,
  MessageProcessingError,
  RateLimitError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  NotImplementedError,
} from './ServiceError';

export {
  ServiceError,
  QueueError,
  MessageProcessingError,
  RateLimitError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  NotImplementedError,
};

// For backward compatibility
// TODO: Remove this export after verifying it's not used anywhere
export { BaseError as AppError } from './BaseError';

/**
 * Extended error interface with additional properties
 */
export interface ExtendedError {
  code: string;
  message: string;
  requestId?: string;
  details?: Record<string, any>;
}

// Error utilities for service integration
export {
  createServiceErrorHandler,
  createEnhancedAssertValid,
  createServiceErrorMiddleware
} from './errorUtils';
