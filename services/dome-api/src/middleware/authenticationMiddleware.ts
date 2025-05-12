import { Context, Next } from 'hono';
import { getLogger, logError, updateContext } from '@dome/common';
import LRUCache from 'lru-cache';
import type { Bindings } from '../types';
import { createServiceFactory } from '../services/serviceFactory';
import { incrementCounter, trackTiming } from '../utils/metrics';

// Context with authenticated user
export interface AuthContext {
  userId: string;
  userRole: string;
  userEmail: string;
}

interface CachedToken {
  user: AuthContext;
  expiresAt: number;
}

const tokenCache = new LRUCache<string, CachedToken>({
  max: 10000, // 10k entries
  ttl: 300 * 1000, // 300 seconds TTL for cache entries themselves
});

const AUTH_SERVICE_CALL_METRIC = 'auth.service.call_duration';
const CACHE_HIT_METRIC = 'auth.cache.hit';
const CACHE_MISS_METRIC = 'auth.cache.miss';

/**
 * Authentication middleware for protecting routes
 * Validates JWT tokens and adds user info to context
 */
export const authenticationMiddleware = async (
  c: Context<{ Bindings: Bindings; Variables: { auth: AuthContext } }>,
  next: Next,
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
      401,
    );
  }

  try {
    const token = authHeader.slice(7);

    // Check cache first
    const cachedEntry = tokenCache.get(token);
    if (cachedEntry && cachedEntry.expiresAt > Date.now()) {
      incrementCounter(CACHE_HIT_METRIC);
      c.set('auth', cachedEntry.user);
      logger.debug({ userId: cachedEntry.user.userId }, 'User authenticated from cache');
      await updateContext({
        identity: {
          userId: cachedEntry.user.userId,
          role: cachedEntry.user.userRole,
          email: cachedEntry.user.userEmail,
        },
      });
      // Propagate identity via baggage header
      const baggageValue = `user=${Buffer.from(
        JSON.stringify({
          id: cachedEntry.user.userId,
          role: cachedEntry.user.userRole,
          email: cachedEntry.user.userEmail,
        }),
      ).toString('base64url')}`;
      c.header('baggage', baggageValue);

      await next();
      return;
    }

    incrementCounter(CACHE_MISS_METRIC);

    // Use auth service client from service factory
    const serviceFactory = createServiceFactory();
    const authService = serviceFactory.getAuthService(c.env);

    // Validate token
    const trackAuthServiceCall = trackTiming(AUTH_SERVICE_CALL_METRIC);
    const response = await trackAuthServiceCall(async () => authService.validateToken(token, "privy"));
    const success = response.success;
    const user = response.user; // Corrected: access user directly
    const ttl = response.ttl;   // Corrected: access ttl directly

    if (!success || !user) { // user can be undefined as per ValidateTokenResponse
      logger.warn({ responseFromAuthService: response }, 'Invalid token based on auth service response');
      return c.json(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Invalid or expired token',
          },
        },
        401,
      );
    }

    // Set user info in context
    const authContextData: AuthContext = {
      userId: user.id,
      userRole: user.role,
      userEmail: user.email,
    };
    c.set('auth', authContextData);

    // Store in cache with appropriate TTL (max 300s)
    const cacheTtl = ttl && ttl > 0 ? Math.min(ttl, 300) * 1000 : 300 * 1000;
    tokenCache.set(token, { user: authContextData, expiresAt: Date.now() + cacheTtl });

    logger.debug({ userId: user.id }, 'User authenticated via service');
    await updateContext({
      identity: {
        userId: user.id,
        role: user.role,
        email: user.email,
      },
    });

    // Propagate identity via baggage header
    const baggageValue = `user=${Buffer.from(
      JSON.stringify({ id: user.id, role: user.role, email: user.email }),
    ).toString('base64url')}`;
    c.header('baggage', baggageValue);

    // Continue to next middleware/handler
    await next();
  } catch (error) {
    logError(error, 'Authentication error');
    return c.json(
      {
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication failed',
        },
      },
      401,
    );
  }
};

/**
 * Role-based access control middleware factory
 * Creates middleware that ensures user has required role
 */
export const createRoleMiddleware = (requiredRoles: string[]) => {
  return async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
    const logger = getLogger().child({ component: 'RoleMiddleware' });
    const userRole = c.get('auth')?.userRole;

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
        403,
      );
    }

    await next();
  };
};
