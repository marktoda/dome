import { Context, Next } from 'hono';
import { UnauthorizedError } from '@dome/common';
import { getLogger } from '@dome/logging';
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
  // Get user ID from auth context (set by authenticationMiddleware)
  // Fall back to header/query for backward compatibility during transition
  const userIdFromAuth = c.get('userId');
  const userIdFromHeader = c.req.header('x-user-id') || c.req.query('userId');
  const userId = userIdFromAuth || userIdFromHeader;

  getLogger().debug({ userId, path: c.req.path }, 'Ensuring user ID is in context');

  if (!userId) {
    getLogger().warn({ path: c.req.path }, 'Missing user ID in request');
    throw new UnauthorizedError('User ID is required');
  }

  // Ensure the user ID is in the context for controllers
  c.set('userId', userId);

  getLogger().debug({ userId, path: c.req.path }, 'User ID validated and attached to context');

  await next();
};
