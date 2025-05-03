import { Context, Next } from 'hono';
import { getLogger } from '@dome/logging';
import type { Bindings } from '../types';
import { createServiceFactory } from '../services/serviceFactory';
import {
  Identity,
  withIdentityContext,
  getIdentityContext,
  encodeIdentityAsBaggage
} from '@dome/common/identity';

// Context with authenticated user
export interface AuthContext {
  userId: string;
  userRole: string;
  userEmail: string;
}

/**
 * Authentication middleware options
 */
export interface AuthOptions {
  // Any other options can be added here in the future
}

/**
 * Default authentication middleware
 * Validates JWT tokens, adds user info to context, and establishes identity propagation
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

    // Set user info in context for backward compatibility with existing code
    c.set('userId', user.id);
    c.set('userRole', user.role);
    c.set('userEmail', user.email);

    logger.debug({ userId: user.id }, 'User authenticated');

    // Create identity for identity context propagation
    const identity: Identity = {
      uid: user.id
      // Organization field can be added later if needed
    };

    // Establish identity context and continue with request
    return setupIdentityContext(c, identity, next, logger);
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
 * Factory function for creating authentication middleware with options
 * @param options Configuration options for the middleware
 * @returns Authentication middleware function
 */
export const createAuthMiddleware = (options?: AuthOptions) => {
  return authenticationMiddleware;
};

/**
 * Sets up the identity context and continues with the request
 *
 * @param c Hono context
 * @param identity User identity to establish
 * @param next Next middleware/handler function
 * @param logger Logger instance
 * @returns Promise from the next handler
 */
export function setupIdentityContext(
  c: Context,
  identity: Identity,
  next: Next,
  logger = getLogger().child({ component: 'IdentityContext' })
): Promise<Response | void> {
  // Store identity in Hono context for easy access
  c.set('identity', identity);
  
  // Encode identity as baggage string for downstream propagation
  const baggage = encodeIdentityAsBaggage(identity);
  
  // Store the baggage in the context for use in outgoing requests
  c.set('baggage', baggage);

  // Establish identity in AsyncLocalStorage context using the common library
  return withIdentityContext(identity, async () => {
    // Add a hook to set W3C baggage header on outgoing fetch requests
    const originalFetch = globalThis.fetch;
    
    try {
      globalThis.fetch = async (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set('baggage', baggage);
        return originalFetch(url, { ...init, headers });
      };

      // Continue to the next middleware/handler
      return await next();
    } finally {
      // Restore original fetch implementation
      if (typeof globalThis.fetch !== 'undefined') {
        globalThis.fetch = originalFetch;
      }
    }
  });
}

/**
 * Gets the current identity from context or AsyncLocalStorage
 *
 * @param c Hono context
 * @returns Identity object with user information
 */
export function getCurrentIdentity(c: Context): Identity {
  // First try to get from Hono context
  const identity = c.get('identity') as Identity | undefined;
  
  if (identity) {
    return identity;
  }
  
  // Try to get from AsyncLocalStorage as fallback
  try {
    // Use the standard identity context from common library
    return getIdentityContext();
  } catch (error) {
    // If identity not found, try to construct from individual context variables
    const userId = c.get('userId');
    if (userId) {
      return {
        uid: userId,
      };
    }
    
    // If no identity is found, throw an error
    const logger = getLogger().child({ component: 'AuthMiddleware' });
    logger.error('No user identity found in context');
    throw new Error('User identity not found in request context');
  }
}

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
    
    try {
      // Get role from context (we don't store roles in Identity)
      const userRole = c.get('userRole');
      
      // Check if the user has any of the required roles
      const hasRequiredRole = requiredRoles.includes(userRole);
      
      if (!hasRequiredRole) {
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
    } catch (error) {
      logger.error({ error }, 'Role middleware error');
      return c.json(
        {
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Access control error',
          },
        },
        403
      );
    }
  };
};

/**
 * Helper function to add baggage header to outgoing requests
 * Used for HTTP fetch requests to propagate identity between services
 *
 * @param headers Headers object to modify
 * @param c Hono context
 */
export function addBaggageHeader(headers: Headers, c: Context): void {
  // First try to get baggage from context
  const baggage = c.get('baggage') as string | undefined;
  
  if (baggage) {
    headers.set('baggage', baggage);
    return;
  }
  
  // If no baggage in context, try to get identity and encode it
  try {
    // Get identity from context or AsyncLocalStorage
    const identity = getCurrentIdentity(c);
    
    // Encode and add as baggage header
    headers.set('baggage', encodeIdentityAsBaggage(identity));
  } catch (error) {
    // If identity can't be retrieved, don't add the header
    const logger = getLogger().child({ component: 'AuthMiddleware' });
    logger.debug('Could not add baggage header: No identity available');
  }
}
