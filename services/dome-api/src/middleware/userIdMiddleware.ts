import { Context, Next } from 'hono';
import { UnauthorizedError } from '@dome/common';
import { getLogger } from '@dome/logging';
import { Bindings } from '../types';

/**
 * Extended Hono context with user ID
 */
export type UserIdContext = {
  userId: string;
};

/**
 * Middleware to validate user ID and attach it to the request context
 *
 * This middleware extracts the user ID from the request headers or query parameters,
 * validates it, and attaches it to the request context for use in controllers.
 *
 * @param c Hono context
 * @param next Next function
 * @returns Response
 */
export const userIdMiddleware = async (
  c: Context<{ Bindings: Bindings; Variables: UserIdContext }>,
  next: Next,
) => {
  // Get user ID from request headers or query parameters
  const userId = c.req.header('x-user-id') || c.req.query('userId');

  getLogger().debug({ userId, path: c.req.path }, 'Validating user ID');

  if (!userId) {
    getLogger().warn({ path: c.req.path }, 'Missing user ID in request');
    throw new UnauthorizedError(
      'User ID is required. Provide it via x-user-id header or userId query parameter',
    );
  }

  // Attach the user ID to the request variables for use in controllers
  c.set('userId', userId);

  getLogger().debug({ userId, path: c.req.path }, 'User ID validated and attached to context');

  await next();
};
