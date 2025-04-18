/**
 * Middleware module for the common package
 * Exports all middleware functions
 */
export { createRequestContextMiddleware } from './requestContext';
export { createErrorMiddleware } from './errorMiddleware';
export { responseHandlerMiddleware } from './responseHandlerMiddleware';
export { createPinoLoggerMiddleware } from './pinoLogger';
export { createRateLimitMiddleware } from './rateLimitMiddleware';
export { createAuthMiddleware, createSimpleAuthMiddleware } from './authMiddleware';
export {
  createEnhancedAuthMiddleware,
  getUserInfo,
  requirePermissions,
  requireRole,
  requireOwnership,
  UserRole,
} from './enhancedAuthMiddleware';
