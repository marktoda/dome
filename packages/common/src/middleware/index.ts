/**
 * Middleware module for the common package
 * Exports all middleware functions
 */

// Request context middleware
export { createRequestContextMiddleware } from './requestContext.js';

// Error middleware
export { createErrorMiddleware } from './errorMiddleware.js';

// Response handler middleware
export { responseHandlerMiddleware } from './responseHandlerMiddleware.js';

// Detailed logger middleware
export { createDetailedLoggerMiddleware, initLogging } from './detailedLoggerMiddleware.js';

// Rate limit middleware
export { createRateLimitMiddleware } from './rateLimitMiddleware.js';

// Authentication middleware
export { createAuthMiddleware, createSimpleAuthMiddleware } from './authMiddleware.js';

// Enhanced authentication middleware
export {
  createEnhancedAuthMiddleware,
  getUserInfo,
  requirePermissions,
  requireRole,
  requireOwnership,
  UserRole,
} from './enhancedAuthMiddleware.js';
