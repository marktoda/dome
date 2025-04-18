/**
 * Error module for the common package
 * Exports all error classes and utility functions
 */
// Base error class
export { BaseError } from './BaseError';
// Validation errors
import { ValidationError, SchemaValidationError, MessageFormatError, BatchValidationError, } from './ValidationError';
export { ValidationError, SchemaValidationError, MessageFormatError, BatchValidationError };
// Service errors
import { ServiceError, QueueError, MessageProcessingError, RateLimitError, NotFoundError, UnauthorizedError, ForbiddenError, NotImplementedError, } from './ServiceError';
export { ServiceError, QueueError, MessageProcessingError, RateLimitError, NotFoundError, UnauthorizedError, ForbiddenError, NotImplementedError, };
// For backward compatibility
export { BaseError as AppError } from './BaseError';
//# sourceMappingURL=index.js.map