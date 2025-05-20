/**
 * Error module for the common package
 * Exports all error classes and utility functions
 */

// Base error class
export { BaseError } from './BaseError.js';

// Validation errors
import {
  ValidationError,
  SchemaValidationError,
  MessageFormatError,
  BatchValidationError,
} from './ValidationError.js';

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
} from './ServiceError.js';

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
  createServiceErrorMiddleware,
} from './errorUtils.js';

// Dome error classes and helpers copied from @dome/errors
export {
  DomeError,
  ValidationError as DomeValidationError,
  NotFoundError as DomeNotFoundError,
  UnauthorizedError as DomeUnauthorizedError,
  ForbiddenError as DomeForbiddenError,
  BadRequestError,
  InternalError,
  ServiceUnavailableError,
  RateLimitError as DomeRateLimitError,
  ConflictError,
  toDomeError,
  createErrorFactory,
  createErrorWrapper,
  assertValid as domeAssertValid,
  assertExists as domeAssertExists,
  handleDatabaseError,
  errorHandler,
} from './domeErrors.js';
