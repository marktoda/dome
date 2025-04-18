import type { Context, MiddlewareHandler, Next } from 'hono';
import { UnauthorizedError, ForbiddenError } from '../errors/ServiceError';

/**
 * User role enum
 */
export enum UserRole {
  USER = 'user',
  ADMIN = 'admin',
}

/**
 * User information interface
 */
export interface UserInfo {
  id: string;
  email?: string;
  role: UserRole;
  permissions?: string[];
}

/**
 * Enhanced authentication middleware options
 */
export interface EnhancedAuthOptions {
  /**
   * Header name for the authorization token
   * @default 'authorization'
   */
  authHeaderName?: string;

  /**
   * Header name for the user ID (for development)
   * @default 'x-user-id'
   */
  userIdHeaderName?: string;

  /**
   * Whether to skip authentication in development mode
   * @default true
   */
  skipInDevelopment?: boolean;

  /**
   * Required permissions for the route
   */
  requiredPermissions?: string[];

  /**
   * Required role for the route
   */
  requiredRole?: UserRole;
}

/**
 * Creates an enhanced authentication middleware that validates JWT tokens
 * and provides user information to the request context
 *
 * @param options Authentication options
 * @returns Middleware handler
 */
export function createEnhancedAuthMiddleware(options?: EnhancedAuthOptions): MiddlewareHandler {
  const {
    authHeaderName = 'authorization',
    userIdHeaderName = 'x-user-id',
    skipInDevelopment = true,
    requiredPermissions = [],
    requiredRole,
  } = options || {};

  return async (c: Context, next: Next) => {
    // Get environment
    const environment = c.env?.ENVIRONMENT || 'development';

    // For development mode, use simplified auth
    if (skipInDevelopment && environment === 'development') {
      // Get user ID from header
      const userId = c.req.header(userIdHeaderName);

      if (!userId) {
        // In development, if no user ID is provided, create a default one
        const defaultUserId = 'dev-user-123';

        // Set user info in the context
        c.set('userInfo', {
          id: defaultUserId,
          role: UserRole.ADMIN, // Give admin role in development
          permissions: ['*'], // All permissions in development
        });
      } else {
        // Set user info in the context
        c.set('userInfo', {
          id: userId,
          role: UserRole.ADMIN, // Give admin role in development
          permissions: ['*'], // All permissions in development
        });
      }

      await next();
      return;
    }

    // Get authorization header
    const authHeader = c.req.header(authHeaderName);

    // Check if authorization header is provided
    if (!authHeader) {
      throw new UnauthorizedError('Authorization header is required');
    }

    // Check if it's a Bearer token
    if (!authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError('Invalid authorization format. Use Bearer token');
    }

    // Extract the token
    const token = authHeader.substring(7);

    try {
      // In a real implementation, we would validate the JWT token
      // For now, we'll use a simplified approach for demonstration

      // Parse the token (in a real implementation, this would be JWT verification)
      const userInfo = parseToken(token);

      // Set user info in the context
      c.set('userInfo', userInfo);

      // Check role if required
      if (requiredRole && userInfo.role !== requiredRole) {
        throw new ForbiddenError(`Required role: ${requiredRole}`);
      }

      // Check permissions if required
      if (requiredPermissions.length > 0) {
        const hasAllPermissions = requiredPermissions.every(
          permission =>
            userInfo.permissions?.includes(permission) || userInfo.permissions?.includes('*'),
        );

        if (!hasAllPermissions) {
          throw new ForbiddenError(
            `Missing required permissions: ${requiredPermissions.join(', ')}`,
          );
        }
      }

      // Continue to next middleware
      await next();
    } catch (error) {
      if (error instanceof ForbiddenError) {
        throw error;
      }

      throw new UnauthorizedError('Invalid or expired token');
    }
  };
}

/**
 * Parse a token to extract user information
 * This is a simplified implementation for demonstration purposes
 * In a real application, this would validate a JWT token
 *
 * @param token JWT token
 * @returns User information
 */
function parseToken(token: string): UserInfo {
  try {
    // In a real implementation, this would be JWT verification
    // For now, we'll use a simplified approach

    // Check if the token is in the format "userId:role:permissions"
    const parts = token.split(':');

    if (parts.length >= 2) {
      const userId = parts[0];
      const role = parts[1] as UserRole;
      const permissions = parts.length > 2 ? parts[2].split(',') : [];

      return {
        id: userId,
        role: Object.values(UserRole).includes(role) ? role : UserRole.USER,
        permissions,
      };
    }

    // If the token doesn't match the expected format, treat it as the user ID
    return {
      id: token,
      role: UserRole.USER,
      permissions: [],
    };
  } catch (error) {
    console.error('Error parsing token:', error);
    throw new UnauthorizedError('Invalid token format');
  }
}

/**
 * Helper function to get user info from context
 *
 * @param c Hono context
 * @returns User information
 */
export function getUserInfo(c: Context): UserInfo {
  const userInfo = c.get('userInfo');

  if (!userInfo) {
    throw new UnauthorizedError('User information not found in context');
  }

  return userInfo;
}

/**
 * Creates a middleware that requires specific permissions
 *
 * @param permissions Required permissions
 * @returns Middleware handler
 */
export function requirePermissions(permissions: string[]): MiddlewareHandler {
  return createEnhancedAuthMiddleware({
    requiredPermissions: permissions,
  });
}

/**
 * Creates a middleware that requires a specific role
 *
 * @param role Required role
 * @returns Middleware handler
 */
export function requireRole(role: UserRole): MiddlewareHandler {
  return createEnhancedAuthMiddleware({
    requiredRole: role,
  });
}

/**
 * Creates a middleware that ensures the user can only access their own resources
 *
 * @param paramName Parameter name that contains the resource owner ID
 * @returns Middleware handler
 */
export function requireOwnership(paramName: string = 'userId'): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const userInfo = getUserInfo(c);
    const resourceOwnerId = c.req.param(paramName);

    if (!resourceOwnerId) {
      throw new ForbiddenError(`Resource owner ID parameter '${paramName}' not found`);
    }

    if (userInfo.role !== UserRole.ADMIN && userInfo.id !== resourceOwnerId) {
      throw new ForbiddenError('You can only access your own resources');
    }

    await next();
  };
}
