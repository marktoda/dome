import { Context, Next } from 'hono';
import { getLogger } from '@dome/logging';
import type { Bindings } from '../types';
import { createServiceFactory } from '../services/serviceFactory';

// Context with authenticated user
export interface AuthContext {
  userId: string;
  userRole: string;
  userEmail: string;
}

/**
 * Authentication middleware for protecting routes
 * Validates JWT tokens and adds user info to context
 */
export const authenticationMiddleware = async (
  c: Context<{ Bindings: Bindings; Variables: AuthContext }>,
  next: Next
) => {
  const logger = getLogger().child({ component: 'AuthMiddleware' });
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn('Missing or invalid Authorization header');
    return c.json(
      {
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        },
      },
      401
    );
  }

  try {
    const token = authHeader.slice(7);

    // Use auth service client from service factory
    const serviceFactory = createServiceFactory();
    const authService = serviceFactory.getAuthService(c.env);

    // Validate token
    const { success, user } = await authService.validateToken(token);

    if (!success || !user) {
      logger.warn('Invalid token');
      return c.json(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Invalid or expired token',
          },
        },
        401
      );
    }

    // Set user info in context
    c.set('userId', user.id);
    c.set('userRole', user.role);
    c.set('userEmail', user.email);

    logger.debug({ userId: user.id }, 'User authenticated');

    // Continue to next middleware/handler
    await next();
  } catch (error) {
    logger.error({ error }, 'Authentication error');
    return c.json(
      {
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication failed',
        },
      },
      401
    );
  }
};

/**
 * Role-based access control middleware factory
 * Creates middleware that ensures user has required role
 */
export const createRoleMiddleware = (requiredRoles: string[]) => {
  return async (
    c: Context<{ Variables: AuthContext }>,
    next: Next
  ) => {
    const logger = getLogger().child({ component: 'RoleMiddleware' });
    const userRole = c.get('userRole');

    if (!userRole || !requiredRoles.includes(userRole)) {
      logger.warn({ userRole, requiredRoles }, 'Insufficient permissions');
      return c.json(
        {
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Insufficient permissions',
          },
        },
        403
      );
    }

    await next();
  };
};
