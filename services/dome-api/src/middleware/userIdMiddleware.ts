import { Context, Next } from 'hono';
import { UnauthorizedError } from '@dome/common';
import { getLogger } from '@dome/common';
import { Bindings } from '../types';
import { AuthContext } from './authenticationMiddleware';

/**
 * Extended Hono context with user ID
 */
export type UserIdContext = {
  userId: string;
};

/**
 * Middleware to obtain user ID from auth context
 *
 * This middleware gets the user ID from the auth context (set by authenticationMiddleware)
 * and ensures it's available in the UserIdContext for backward compatibility.
 *
 * @param c Hono context
 * @param next Next function
 * @returns Response
 */
export const userIdMiddleware = async (
  c: Context<{ Bindings: Bindings; Variables: UserIdContext & Partial<AuthContext> }>,
  next: Next,
) => {
  const logger = getLogger().child({
    component: 'UserIdMiddleware',
    requestId: Math.random().toString(36).substring(2, 12),
    path: c.req.path,
    method: c.req.method,
    headers: {
      authorization: !!c.req.header('Authorization'),
      'x-user-id': !!c.req.header('x-user-id'),
    },
  });

  logger.info('UserIdMiddleware started');

  const userIdFromAuth = c.get('userId');
  const userIdFromHeader = c.req.header('x-user-id') || c.req.query('userId');
  const authHeader = c.req.header('Authorization');

  logger.info(
    {
      userIdFromAuth: userIdFromAuth || '[not set]',
      userIdFromHeader: userIdFromHeader || '[not set]',
      hasAuthHeader: !!authHeader,
      allHeaders: Object.fromEntries(
        [...c.req.raw.headers.entries()]
          .filter(
            ([key]) => !key.includes('auth') && !key.includes('cookie') && !key.includes('secret'),
          )
          .map(([key, value]) => [
            key,
            typeof value === 'string' ? value.substring(0, 20) : '[binary]',
          ]),
      ),
      allContext: {
        userId: c.get('userId') || '[not set]',
        userRole: c.get('userRole') || '[not set]',
        userEmail: c.get('userEmail') || '[not set]',
      },
    },
    'UserIdMiddleware - detailed context',
  );

  // Use authenticated user ID when available, only fallback to header in unauthenticated routes
  const isAuthRoute =
    c.req.path.startsWith('/auth') || c.req.path === '/' || c.req.path === '/health';

  // If auth information is expected (non-auth routes) but missing, don't accept header/query params
  if (!isAuthRoute && !userIdFromAuth && userIdFromHeader) {
    logger.warn(
      { path: c.req.path, headerUserId: userIdFromHeader },
      'Rejecting unauthenticated user ID from header/query - missing auth context',
    );
    throw new UnauthorizedError('Authentication required');
  }

  // Only use the header user ID on explicitly unauthenticated routes
  const userId = userIdFromAuth || (isAuthRoute ? userIdFromHeader : null);

  logger.info(
    {
      userIdFromAuth,
      userIdFromHeader,
      isAuthRoute,
      finalUserId: userId,
      path: c.req.path,
    },
    'User ID resolution completed',
  );

  if (!userId) {
    getLogger().warn({ path: c.req.path }, 'Missing user ID in request');
    throw new UnauthorizedError('User ID is required');
  }

  // Ensure the user ID is in the context for controllers
  c.set('userId', userId);

  getLogger().debug({ userId, path: c.req.path }, 'User ID validated and attached to context');

  await next();
};
