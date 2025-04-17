/**
 * Middleware module for the common package
 * Exports all middleware functions
 */

// Request context middleware
export { createRequestContextMiddleware } from './requestContext';

// Error middleware
export { createErrorMiddleware } from './errorMiddleware';

// Response handler middleware
export { responseHandlerMiddleware } from './responseHandlerMiddleware';

// Pino logger middleware
export { createPinoLoggerMiddleware } from './pinoLogger';

// Rate limit middleware
export { createRateLimitMiddleware } from './rateLimitMiddleware';

// Authentication middleware
export { createAuthMiddleware, createSimpleAuthMiddleware } from './authMiddleware';
