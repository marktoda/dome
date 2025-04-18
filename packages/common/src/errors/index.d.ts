/**
 * Error module for the common package
 * Exports all error classes and utility functions
 */
export { BaseError } from './BaseError';
import {
  ValidationError,
  SchemaValidationError,
  MessageFormatError,
  BatchValidationError,
} from './ValidationError';
export { ValidationError, SchemaValidationError, MessageFormatError, BatchValidationError };
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
