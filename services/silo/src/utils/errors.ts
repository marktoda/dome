import {
  ValidationError,
  NotFoundError,
  ConflictError,
  ServiceUnavailableError,
  UnauthorizedError,
  createErrorFactory,
  domeAssertExists as assertExists,
} from '@dome/common';
import {
  createServiceErrorHandler,
  createEnhancedAssertValid,
  createServiceErrorMiddleware,
} from '@dome/common';

// Service name constant for consistency
const SERVICE_NAME = 'silo';

// Create domain-specific error factory
export const SiloErrors = createErrorFactory(SERVICE_NAME, {
  service: SERVICE_NAME,
});

// Create service-specific error handling utilities
export const toDomeError = createServiceErrorHandler(SERVICE_NAME);
export const assertValid = createEnhancedAssertValid();
export const createErrorMiddleware = createServiceErrorMiddleware(SERVICE_NAME);

// Re-export common errors
export {
  ValidationError,
  NotFoundError,
  ConflictError,
  ServiceUnavailableError,
  UnauthorizedError,
  assertExists,
  createErrorFactory,
};
