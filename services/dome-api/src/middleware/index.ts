/**
 * Middleware index file
 * Exports all middleware components and utilities
 */

// Authentication middleware
export {
  authenticationMiddleware,
  createRoleMiddleware,
  type AuthContext,
} from './authenticationMiddleware';

// Metrics middleware
export * from './metricsMiddleware';
