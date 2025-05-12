import { Context, Next, MiddlewareHandler } from 'hono';
import { BaseError, UnauthorizedError, ForbiddenError, ValidationError } from '@dome/common/errors';
import { getLogger } from '@dome/common'; // Corrected: getLogger from @dome/common
import { AuthService as UnifiedAuthService } from '../services/auth-service'; // Use new UnifiedAuthService
import { UserManager } from '../services/user/user-manager'; // For fetching full user if needed
// Import the schema-inferred User type to ensure userFromDb matches this.
import type { User as SchemaUser } from '../interfaces/auth-provider.interface';


// Define the shape of the context variables set by this middleware.
// The User type here is defined explicitly to match Hono's expected structure from the error.
export interface AuthenticatedContextEnv {
  Variables: {
    user?: {
      id: string;
      email: string;
      password?: string | null; // Adjusted to match schema more closely (nullable)
      name?: string | null;     // Adjusted to match schema
      role: "user" | "admin";
      emailVerified: boolean;
      lastLoginAt?: Date | null; // Adjusted to match schema
      isActive: boolean;
      authProvider?: string | null; // Adjusted to match schema
      providerAccountId?: string | null; // Adjusted to match schema
      createdAt: Date;
      updatedAt: Date;
    };
    tokenPayload?: { userId: string; provider: string; details?: any }; // Raw validated token payload
  };
}

/**
 * Authentication middleware factory
 * Creates middleware that validates JWT tokens and adds user information to context.
 *
 * @param unifiedAuthService The unified authentication service instance.
 * @param userManager Instance of UserManager to fetch full user details.
 * @returns Middleware handler for authentication.
 */
export function createAuthMiddleware(
  unifiedAuthService: UnifiedAuthService,
  userManager: UserManager, // Pass UserManager to fetch full user details
): MiddlewareHandler<AuthenticatedContextEnv> {
  const logger = getLogger().child({ component: 'AuthMiddleware' });

  return async (c: Context<AuthenticatedContextEnv>, next: Next) => {
    try {
      const authHeader = c.req.header('Authorization');

      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new UnauthorizedError('Missing or malformed authorization token.');
      }

      const token = authHeader.slice(7); // Remove "Bearer "
      logger.debug('Attempting to validate auth token.');

      // Validate the token using the unified auth service
      // The providerName can be omitted if the token is self-contained (e.g. JWT with issuer claim)
      // or if unifiedAuthService.validateToken can infer it or try multiple.
      const validatedPayload = await unifiedAuthService.validateToken(token /*, optionalProviderNameFromRequest */);
      
      logger.info({ userId: validatedPayload.userId, provider: validatedPayload.provider }, 'Token validation successful.');
      c.set('tokenPayload', validatedPayload);

      // Fetch full user details using UserManager
      // This assumes that `validatedPayload.userId` is the standard user ID in your system.
      const userFromDb: SchemaUser | null = await userManager.findUserById(validatedPayload.userId, { db: (c.env as any).AUTH_DB, env: c.env as any }); // Pass context for DB access
      if (!userFromDb) {
        logger.warn({ userId: validatedPayload.userId }, 'User not found for validated token.');
        throw new UnauthorizedError('User associated with token not found.');
      }
      
      // userFromDb is of type SchemaUser (inferred from DB).
      // The context variable `user` is now typed explicitly.
      // Casting to 'any' then to the expected context type to bypass potential subtle type mismatches.
      c.set('user', userFromDb as any as AuthenticatedContextEnv['Variables']['user']);

      await next();
    } catch (error) {
      logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Authentication failed in middleware.');

      if (error instanceof BaseError) {
        // If it's already a structured error from our system
        return c.json({ error: { code: error.code, message: error.message, details: error.details } }, error.status as any);
      }
      // For other errors, return a generic unauthorized response
      const unauthorizedError = new UnauthorizedError('Authentication failed.');
      return c.json(
        { error: { code: unauthorizedError.code, message: unauthorizedError.message, details: unauthorizedError.details } },
        unauthorizedError.status as any
      );
    }
  };
}

/**
 * Role-based access control middleware factory
 * Creates middleware that ensures user has required role.
 * This middleware MUST run AFTER createAuthMiddleware.
 *
 * @param requiredRoles The roles required to access the resource.
 * @returns Middleware handler for role-based access control.
 */
export function createRoleMiddleware(requiredRoles: string[]): MiddlewareHandler<AuthenticatedContextEnv> {
  const logger = getLogger().child({ component: 'RoleMiddleware' });

  return async (c: Context<AuthenticatedContextEnv>, next: Next) => {
    const userInContext = c.get('user');

    if (!userInContext) {
      logger.error('Role middleware executed without an authenticated user in context. Ensure AuthMiddleware runs first.');
      const err = new UnauthorizedError('Authentication required.');
      return c.json({ error: { code: err.code, message: err.message } }, err.status as any);
    }

    // userInContext is of type SchemaUserType, which is inferred from the DB schema
    // and should have the 'role' property.
    const userRole = userInContext.role;

    if (!userRole || !requiredRoles.includes(userRole)) {
      logger.warn({ userId: userInContext.id, userRole, requiredRoles }, 'User does not have required role.');
      const err = new ForbiddenError('Insufficient permissions.');
      return c.json({ error: { code: err.code, message: err.message } }, err.status as any);
    }

    logger.debug({ userId: userInContext.id, userRole }, 'User has required role.');
    await next();
  };
}
