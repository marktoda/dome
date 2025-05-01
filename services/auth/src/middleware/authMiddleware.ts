import { Context, Next, MiddlewareHandler } from 'hono';
import { StatusCode } from 'hono/utils/http-status';
import { getLogger } from '@dome/logging';
import { AuthService } from '../services/authService';
import { User, AuthContext } from '../types';
import { AuthError, AuthErrorType } from '../utils/errors';

// Helper function to convert number to Hono StatusCode
function statusCodeFromNumber(status: number): StatusCode {
  return status as StatusCode;
}

/**
 * Authentication middleware factory
 * Creates middleware that validates JWT tokens and adds user to context
 *
 * @param authService The authentication service
 * @returns Middleware handler for authentication
 */
export function createAuthMiddleware(authService: AuthService): MiddlewareHandler<{
}> {
  const logger = getLogger().child({ component: 'AuthMiddleware' });

  return async (c: Context, next: Next) => {
    try {
      const authHeader = c.req.header('Authorization');

      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new AuthError('Missing token', AuthErrorType.MISSING_TOKEN);
      }

      const token = authHeader.slice(7);
      logger.debug('Verifying auth token');

      try {
        // Validate the token and get user
        const user = await authService.validateToken(token);

        // Add user to context
        c.set('user', user);

        await next();
      } catch (error) {
        logger.error({ error }, 'Token validation failed');

        if (error instanceof AuthError) {
          c.status(statusCodeFromNumber(error.status));
          return c.json(error.toJSON());
        }

        c.status(401);
        return c.json({
          success: false,
          error: {
            type: AuthErrorType.INVALID_TOKEN,
            message: 'Invalid or expired token',
          },
        });
      }
    } catch (error) {
      logger.error({ error }, 'Authentication middleware error');

      if (error instanceof AuthError) {
        c.status(statusCodeFromNumber(error.status));
        return c.json(error.toJSON());
      }

      c.status(401);
      return c.json({
        success: false,
        error: {
          type: AuthErrorType.INVALID_TOKEN,
          message: 'Authentication failed',
        },
      });
    }
  };
}

/**
 * Role-based access control middleware factory
 * Creates middleware that ensures user has required role
 *
 * @param requiredRoles The roles required to access the resource
 * @returns Middleware handler for role-based access control
 */
export function createRoleMiddleware(requiredRoles: string[]): MiddlewareHandler<{
  Variables: AuthContext;
}> {
  const logger = getLogger().child({ component: 'RoleMiddleware' });

  return async (c: Context<{ Variables: AuthContext }>, next: Next) => {
    const user = c.get('user');

    if (!user) {
      logger.error('Role middleware called without authenticated user');
      c.status(401);
      return c.json({
        success: false,
        error: {
          type: AuthErrorType.MISSING_TOKEN,
          message: 'Authentication required',
        },
      });
    }

    if (requiredRoles.includes(user.role)) {
      await next();
      return;
    }

    logger.warn({ userId: user.id, role: user.role, requiredRoles }, 'Insufficient permissions');

    c.status(403);
    return c.json({
      success: false,
      error: {
        type: AuthErrorType.INSUFFICIENT_PERMISSIONS,
        message: 'Insufficient permissions',
      },
    });
  };
}
