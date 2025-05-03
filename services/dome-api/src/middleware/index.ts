/**
 * Middleware index file
 * Exports all middleware components and utilities
 */

// Authentication middleware
export {
  authenticationMiddleware,
  createRoleMiddleware,
  getCurrentIdentity,
  setupIdentityContext,
  addBaggageHeader,
  type AuthContext,
  type AuthOptions
} from './authenticationMiddleware';

// Re-export Identity from common package for convenience
export type { Identity } from '@dome/common/identity';

// Metrics middleware
export * from './metricsMiddleware';

// User ID middleware
export * from './userIdMiddleware';