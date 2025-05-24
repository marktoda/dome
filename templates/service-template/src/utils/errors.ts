import { createErrorFactory, createServiceErrorHandler } from '@dome/common/errors';

// Create service-specific error factory
export const ServiceErrors = createErrorFactory('{{SERVICE_NAME}}');

// Create service-specific error handler
export const toDomeError = createServiceErrorHandler('{{SERVICE_NAME}}');

// Example service-specific error types
export const {{SERVICE_NAME}}ValidationError = ServiceErrors.ValidationError;
export const {{SERVICE_NAME}}NotFoundError = ServiceErrors.NotFoundError;
export const {{SERVICE_NAME}}ProcessingError = ServiceErrors.ProcessingError;