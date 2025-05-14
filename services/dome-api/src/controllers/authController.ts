import { Context, Hono } from 'hono';
import { z, createRoute, OpenAPIHono, RouteConfigToTypedResponse } from '@hono/zod-openapi';
import { getLogger, logError } from '@dome/common';
import { createServiceFactory } from '../services/serviceFactory';
// Import User and ValidateTokenResponse from the auth client types
import {
  SupportedAuthProvider,
  User as AuthUser,
  ValidateTokenResponse as AuthValidateTokenResponse,
} from '@dome/auth/client';
import type { AppEnv } from '../types';

// --- Generic Error Schema ---
const ErrorDetailSchema = z.object({
  code: z.string().openapi({ example: 'UNAUTHORIZED' }),
  message: z.string().openapi({ example: 'Authentication failed' }),
});

const ErrorResponseSchema = z
  .object({
    success: z.literal(false).openapi({ example: false }),
    error: ErrorDetailSchema,
  })
  .openapi('ErrorResponse');

// --- Login Schemas and Route (Existing) ---
const LoginBodySchema = z
  .object({
    email: z
      .string()
      .email()
      .openapi({ example: 'mark@example.com', description: "User's email address" }),
    password: z
      .string()
      .min(8)
      .openapi({ example: 'hunter2', description: "User's password (min 8 characters)" }),
  })
  .openapi('LoginBody');

const LoginResponseSchema = z
  .object({
    token: z
      .string()
      .openapi({ example: 'eyJhbGciOiJIUzI1NiIs…', description: 'JWT authentication token' }),
  })
  .openapi('LoginResponse');

const loginRoute = createRoute({
  method: 'post',
  path: '/login', // Path is relative to the router mount point (/auth)
  summary: 'User Login',
  description: 'Authenticates a user and returns a JWT token upon successful login.',
  request: {
    body: {
      content: {
        'application/json': { schema: LoginBodySchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Login successful, JWT issued.',
      content: { 'application/json': { schema: LoginResponseSchema } },
    },
    401: {
      description: 'Invalid credentials or unauthorized.',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    400: {
      description: 'Bad request (e.g., validation error).',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
  tags: ['Auth'],
});

// --- Register Schemas and Route ---
const RegisterBodySchema = z
  .object({
    email: z
      .string()
      .email()
      .openapi({ example: 'newuser@example.com', description: "New user's email address" }),
    password: z.string().min(8).openapi({
      example: 'securepassword123',
      description: "New user's password (min 8 characters)",
    }),
    name: z.string().min(1).openapi({ example: 'New User', description: "New user's full name" }),
  })
  .openapi('RegisterBody');

// Assuming registration also returns a token, similar to login
const RegisterResponseSchema = z
  .object({
    token: z.string().openapi({
      example: 'eyJhbGciOiJIUzI1NiIs…',
      description: 'JWT authentication token after registration',
    }),
  })
  .openapi('RegisterResponse');

const registerRoute = createRoute({
  method: 'post',
  path: '/register', // Path is relative to the router mount point (/auth)
  summary: 'User Registration',
  description: 'Registers a new user and returns a JWT token.',
  request: {
    body: {
      content: {
        'application/json': { schema: RegisterBodySchema },
      },
      required: true,
    },
  },
  responses: {
    201: {
      // Typically 201 Created for new resources
      description: 'User registered successfully, JWT issued.',
      content: { 'application/json': { schema: RegisterResponseSchema } },
    },
    400: {
      description: 'Bad request (e.g., validation error).',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description: 'Conflict (e.g., user already exists).',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    500: {
      description: 'Internal server error.',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
  tags: ['Auth'],
});

// --- Logout Schemas and Route ---
const LogoutResponseSchema = z
  .object({
    success: z.literal(true).openapi({ example: true }),
    message: z.string().openapi({ example: 'Logout successful' }),
  })
  .openapi('LogoutResponse');

const logoutRoute = createRoute({
  method: 'post',
  path: '/logout', // Path is relative to the router mount point (/auth)
  summary: 'User Logout',
  description: "Invalidates the user's session/token.",
  security: [{ BearerAuth: [] }], // Indicates that this route requires Bearer token authentication
  responses: {
    200: {
      description: 'Logout successful.',
      content: { 'application/json': { schema: LogoutResponseSchema } },
    },
    401: {
      description: 'Unauthorized (e.g., missing or invalid token).',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    500: {
      description: 'Internal server error during logout.',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
  tags: ['Auth'],
});

// --- Validate Token Schemas and Route ---
// This UserProfileSchema defines the shape of the user object in dome-api's /validate response.
// It should be compatible with AuthUser but can be a subset or include transformations (e.g., Date to string).
const UserProfileSchema = z
  .object({
    id: z.string().openapi({ example: 'user-123' }),
    email: z.string().email().openapi({ example: 'user@example.com' }),
    name: z.string().nullable().optional().openapi({ example: 'User Name' }),
    role: z.string().openapi({ example: 'user' }), // AuthUser role is "user" | "admin"
    emailVerified: z.boolean().optional().openapi({ example: true }),
    isActive: z.boolean().optional().openapi({ example: true }),
    // Dates from AuthUser are Date objects; here we expect ISO strings for the API response.
    createdAt: z.string().datetime().openapi({ example: '2023-01-01T00:00:00.000Z' }),
    updatedAt: z.string().datetime().openapi({ example: '2023-01-01T00:00:00.000Z' }),
    lastLoginAt: z
      .string()
      .datetime()
      .nullable()
      .optional()
      .openapi({ example: '2023-01-01T00:00:00.000Z' }),
    authProvider: z
      .nativeEnum(SupportedAuthProvider)
      .nullable()
      .optional()
      .openapi({ example: SupportedAuthProvider.LOCAL }),
    providerAccountId: z.string().nullable().optional().openapi({ example: 'user@example.com' }),
    // The 'provider' field for the response user object will come from the top-level AuthValidateTokenResponse
  })
  .openapi('UserProfile');

// This is the schema for the dome-api's /auth/validate endpoint's response body
const DomeApiValidateTokenResponseSchema = z
  .object({
    success: z.literal(true).openapi({ example: true }),
    // The user object in the response includes the provider
    user: UserProfileSchema.extend({
      provider: z
        .nativeEnum(SupportedAuthProvider)
        .openapi({
          example: SupportedAuthProvider.LOCAL,
          description: 'The authentication provider used.',
        }),
    }),
  })
  .openapi('DomeApiValidateTokenResponse');

// const ValidateTokenResponseSchema = z // This was the old local definition

const validateTokenRoute = createRoute({
  method: 'post', // Or GET, depending on preference. POST is fine.
  path: '/validate', // Path is relative to the router mount point (/auth)
  summary: 'Validate Authentication Token',
  description: 'Validates the provided JWT and returns user information if valid.',
  security: [{ BearerAuth: [] }], // Indicates Bearer token authentication
  responses: {
    200: {
      description: 'Token is valid.',
      content: { 'application/json': { schema: DomeApiValidateTokenResponseSchema } }, // Use the new schema
    },
    401: {
      description: 'Unauthorized (e.g., missing, invalid, or expired token).',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    500: {
      description: 'Internal server error.',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
  tags: ['Auth'],
});

// --- Refresh Token Schemas and Route ---
const RefreshBodySchema = z
  .object({
    refreshToken: z.string().openapi({ example: 'ey...', description: 'Valid refresh token' }),
  })
  .openapi('RefreshBody');

const RefreshResponseSchema = z
  .object({
    token: z.string().openapi({ example: 'ey...', description: 'New access token' }),
    refreshToken: z.string().openapi({ example: 'ey...', description: 'New refresh token' }),
    expiresAt: z.number().openapi({ example: 1717171717, description: 'Expiry (unix seconds)' }),
  })
  .openapi('RefreshResponse');

const refreshRoute = createRoute({
  method: 'post',
  path: '/refresh',
  summary: 'Refresh JWT tokens',
  description: 'Exchanges a refresh token for a new access/refresh token pair.',
  request: {
    body: { content: { 'application/json': { schema: RefreshBodySchema } }, required: true },
  },
  responses: {
    200: {
      description: 'New token pair issued.',
      content: { 'application/json': { schema: RefreshResponseSchema } },
    },
    401: {
      description: 'Invalid or expired refresh token.',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
  tags: ['Auth'],
});

export function buildAuthRouter(): OpenAPIHono<AppEnv> {
  const authController = createAuthController();
  const authRouter = new OpenAPIHono<AppEnv>();

  authRouter.openapi(loginRoute, async c => {
    const validatedBody = c.req.valid('json');
    return authController.login(c, validatedBody);
  });

  authRouter.openapi(registerRoute, async c => {
    const validatedBody = c.req.valid('json');
    return authController.register(c, validatedBody);
  });

  authRouter.openapi(logoutRoute, async c => {
    return authController.logout(c);
  });

  authRouter.openapi(validateTokenRoute, async c => {
    return authController.validateToken(c);
  });

  authRouter.openapi(refreshRoute, async c => {
    const validatedBody = c.req.valid('json');
    return authController.refreshToken(c, validatedBody);
  });

  return authRouter;
}

/**
 * Controller for authentication endpoints
 */
export class AuthController {
  private logger = getLogger().child({ component: 'AuthController' });

  /**
   * Register a new user
   */
  register = async (
    c: Context<AppEnv>,
    body: z.infer<typeof RegisterBodySchema>,
  ): Promise<RouteConfigToTypedResponse<typeof registerRoute>> => {
    try {
      const { email, password, name } = body; // Already validated
      this.logger.debug({ email }, 'User registration request');

      const serviceFactory = createServiceFactory();
      const authService = serviceFactory.getAuthService(c.env);

      // Step 1: Register the user
      // authService.register is expected to throw AuthError on failure (e.g., user exists)
      // or return a User object on success.
      // authService.register (from @dome/auth/client) returns Promise<RegisterResponse>
      // RegisterResponse (from auth/src/types.ts) is { success, user, token, ... }
      const registrationServiceResponse = await authService.register(SupportedAuthProvider.LOCAL, {
        email,
        password,
        name,
      });
      this.logger.info(
        { email, registrationServiceResponse },
        'User registration processed by auth service.',
      );

      if (
        registrationServiceResponse.success &&
        typeof registrationServiceResponse.token === 'string'
      ) {
        // Ensure the response matches local RegisterResponseSchema: { token: string }
        return c.json({ token: registrationServiceResponse.token }, 201);
      }

      // Handle cases where registration succeeded at service level but no token, or success is false
      logError(
        new Error('Registration token missing'), // Create an error object
        'Auth service processed registration, but success was false or token was missing.',
        { email, registrationServiceResponse },
      );
      return c.json(
        {
          success: false as const,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Registration successful, but failed to issue token.',
          },
        },
        500,
      );
    } catch (error: any) {
      logError(error, 'Registration failed with exception', {
        errorDetail: error,
        nestedError: error.error,
      });

      // Check if the error came from AuthError serialization
      if (
        error &&
        error.error &&
        typeof error.error.type === 'string' &&
        error.error.type === 'user_exists'
      ) {
        return c.json(
          {
            success: false as const,
            error: { code: 'CONFLICT', message: error.error.message || 'User already exists' },
          },
          409,
        );
      }

      // Handle other errors or general errors
      // If the RPC call itself fails or returns a non-AuthError structure
      const statusCode = error && typeof error.status === 'number' ? error.status : 400;
      const errorMessage =
        error && error.error && typeof error.error.message === 'string'
          ? error.error.message
          : error && typeof error.message === 'string'
          ? error.message
          : 'Registration processing error';
      const errorCode =
        error && error.error && typeof error.error.type === 'string'
          ? error.error.type.toUpperCase()
          : 'BAD_REQUEST';

      return c.json(
        {
          success: false as const,
          error: {
            code: errorCode,
            message: errorMessage,
          },
        },
        statusCode,
      );
    }
  };

  /**
   * Login a user
   */
  login = async (
    c: Context<AppEnv>,
    body: z.infer<typeof LoginBodySchema>,
  ): Promise<RouteConfigToTypedResponse<typeof loginRoute>> => {
    try {
      const { email, password } = body; // Already validated
      this.logger.debug({ email }, 'User login request');

      const serviceFactory = createServiceFactory();
      const authService = serviceFactory.getAuthService(c.env);
      // authService.login now returns { user, tokenInfo } or throws.
      // The local LoginServiceResponse interface is no longer accurate for the direct service call.
      // authService.login (from @dome/auth/client) returns Promise<LoginResponse>
      // LoginResponse (from auth/src/types.ts) is { success, user, token, ... }
      // For email/password login, this should be LOCAL provider
      const loginServiceResponse = await authService.login(SupportedAuthProvider.LOCAL, {
        email,
        password,
      });
      this.logger.info({ email, loginServiceResponse }, 'User login processed by auth service.');

      if (loginServiceResponse.success && typeof loginServiceResponse.token === 'string') {
        // Ensure the response matches local LoginResponseSchema: { token: string }
        return c.json({ token: loginServiceResponse.token }, 200);
      }

      // Handle cases where login succeeded at service level but no token, or success is false
      this.logger.warn(
        { resultFromService: loginServiceResponse },
        'Auth service processed login, but success was false or token was missing.',
      );
      return c.json(
        {
          success: false as const,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Login successful but failed to issue token.',
          },
        },
        401,
      );
    } catch (error: any) {
      logError(error, 'Login failed with exception');
      return c.json(
        {
          success: false as const,
          error: {
            code: 'UNAUTHORIZED',
            message: String(error.message) || 'Login processing error',
          },
        },
        401,
      );
    }
  };

  /**
   * Logout a user
   */
  logout = async (c: Context<AppEnv>): Promise<RouteConfigToTypedResponse<typeof logoutRoute>> => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        this.logger.warn('Missing or invalid Authorization header for logout');
        return c.json(
          {
            success: false,
            error: { code: 'UNAUTHORIZED', message: 'Authentication token required' },
          },
          401,
        );
      }
      const token = authHeader.slice(7);
      this.logger.debug('User logout request');

      const serviceFactory = createServiceFactory();
      const authService = serviceFactory.getAuthService(c.env);
      interface LogoutServiceResponse {
        success: boolean;
        error?: { code: string; message: string };
      }
      // Assuming logout can be generic or tied to the token's original provider.
      // If it must be privy, this needs to be SupportedAuthProvider.LOCAL
      // For now, let's assume it's tied to the token, so no specific provider or handle this logic in authService
      const result: LogoutServiceResponse = await authService.logout(
        SupportedAuthProvider.LOCAL,
        token,
      );

      if (result.success) {
        return c.json({ success: true, message: 'Logout successful' }, 200);
      }
      logError(new Error('Logout service call failed'), 'Logout service call failed', { result });
      return c.json(
        {
          success: false,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: String(result.error?.message) || 'Logout operation failed',
          },
        },
        500,
      );
    } catch (error: any) {
      logError(error, 'Logout failed with exception');
      return c.json(
        {
          success: false,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: String(error.message) || 'Logout processing error',
          },
        },
        500,
      );
    }
  };

  /**
   * Validate a token
   */
  validateToken = async (
    c: Context<AppEnv>,
  ): Promise<RouteConfigToTypedResponse<typeof validateTokenRoute>> => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        this.logger.warn('Missing or invalid Authorization header for token validation');
        return c.json(
          {
            success: false,
            error: { code: 'UNAUTHORIZED', message: 'Authentication token required' },
          },
          401,
        );
      }
      const token = authHeader.slice(7);
      this.logger.debug('Token validation request');

      const serviceFactory = createServiceFactory();
      const authService = serviceFactory.getAuthService(c.env);

      // Use the imported AuthValidateTokenResponse type from @dome/auth/client
      // This type expects result.user to be an AuthUser object (which includes Date objects)
      const result: AuthValidateTokenResponse = await authService.validateToken(
        token,
        SupportedAuthProvider.LOCAL,
      );

      if (result.success && result.user && result.provider) {
        // result.user is of type AuthUser.
        // DomeApiValidateTokenResponseSchema.shape.user is UserProfileSchema.extend({ provider: ... })
        // UserProfileSchema expects dates as ISO strings.

        // Construct the object to be validated by DomeApiValidateTokenResponseSchema.shape.user
        const apiUserPayload = {
          id: result.user.id,
          email: result.user.email,
          name: result.user.name, // AuthUser.name is string | null; UserProfileSchema.name is string().nullable().optional()
          role: result.user.role, // AuthUser.role is "user" | "admin"; UserProfileSchema.role is string()
          emailVerified: result.user.emailVerified, // AuthUser.emailVerified is boolean; UserProfileSchema.emailVerified is boolean().optional()
          isActive: result.user.isActive, // AuthUser.isActive is boolean; UserProfileSchema.isActive is boolean().optional()
          createdAt: result.user.createdAt.toISOString(), // AuthUser.createdAt is Date; UserProfileSchema.createdAt is string().datetime()
          updatedAt: result.user.updatedAt.toISOString(), // AuthUser.updatedAt is Date; UserProfileSchema.updatedAt is string().datetime()
          lastLoginAt: result.user.lastLoginAt ? result.user.lastLoginAt.toISOString() : null, // AuthUser.lastLoginAt is Date | null
          authProvider: result.user.authProvider, // AuthUser.authProvider is string | null
          providerAccountId: result.user.providerAccountId, // AuthUser.providerAccountId is string | null
          provider: result.provider, // This comes from the top level of AuthValidateTokenResponse
        };

        // Validate this constructed object against the schema for the 'user' part of the API response
        const apiUserResponseSchema = DomeApiValidateTokenResponseSchema.shape.user;
        const validation = apiUserResponseSchema.safeParse(apiUserPayload);

        if (!validation.success) {
          logError(
            new Error('User profile data for API response failed Zod validation'),
            'Constructed user profile data failed Zod validation against DomeApiValidateTokenResponseSchema.shape.user.',
            {
              errors: validation.error.flatten(),
              rawAuthUser: result.user,
              constructedForApi: apiUserPayload,
            },
          );
          return c.json(
            {
              success: false,
              error: {
                code: 'INTERNAL_SERVER_ERROR',
                message: 'Invalid user profile structure after processing for API response.',
              },
            },
            500,
          );
        }
        // validation.data now conforms to UserProfileSchema.extend({ provider: ... })
        // and should have the 'provider' field.
        return c.json({ success: true, user: validation.data }, 200);
      }

      this.logger.warn(
        { resultFromAuthService: result }, // Log the actual result from the auth service
        'Token validation service call failed, did not return user profile, or success was false.',
      );
      return c.json(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            // Access result.error safely if it exists, otherwise provide a generic message
            message:
              result && (result as any).error && typeof (result as any).error.message === 'string'
                ? (result as any).error.message
                : 'Invalid or expired token, or user data missing.',
          },
        },
        401,
      );
    } catch (error: any) {
      logError(error, 'Token validation failed with exception');
      if (error instanceof z.ZodError) {
        // This case should ideally be caught by the safeParse above.
        logError(error, 'UserProfileSchema validation failed unexpectedly during catch block.', {
          errors: error.flatten(),
        });
        return c.json(
          {
            success: false,
            error: {
              code: 'INTERNAL_SERVER_ERROR',
              message: 'User data structure error after validation.',
            },
          },
          500,
        );
      }
      return c.json(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: String(error.message) || 'Token validation processing error',
          },
        },
        401,
      );
    }
  };

  /**
   * Refresh a token
   */
  refreshToken = async (
    c: Context<AppEnv>,
    body: z.infer<typeof RefreshBodySchema>,
  ): Promise<RouteConfigToTypedResponse<typeof refreshRoute>> => {
    try {
      const { refreshToken } = body; // Already validated
      this.logger.debug({ refreshToken }, 'Token refresh request');

      const serviceFactory = createServiceFactory();
      interface AuthServiceWithRefresh {
        refreshToken(
          token: string,
        ): Promise<{ success: boolean; token: string; refreshToken: string; expiresAt: number }>;
      }
      const authService = serviceFactory.getAuthService(c.env) as unknown as AuthServiceWithRefresh;
      const refreshServiceResponse = await authService.refreshToken(refreshToken);
      this.logger.info(
        { refreshToken, refreshServiceResponse },
        'Token refresh processed by auth service.',
      );

      if (refreshServiceResponse && refreshServiceResponse.success) {
        const resp = {
          token: refreshServiceResponse.token,
          refreshToken: refreshServiceResponse.refreshToken,
          expiresAt: refreshServiceResponse.expiresAt,
        } satisfies z.infer<typeof RefreshResponseSchema>;
        return c.json(resp, 200);
      }

      // Handle cases where refresh succeeded at service level but no token, or success is false
      this.logger.warn(
        { resultFromService: refreshServiceResponse },
        'Auth service processed refresh, but success was false or token was missing.',
      );
      return c.json(
        {
          success: false as const,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Refresh successful but failed to issue token.',
          },
        },
        401,
      );
    } catch (error: any) {
      logError(error, 'Refresh token failed with exception');
      return c.json(
        {
          success: false as const,
          error: {
            code: 'UNAUTHORIZED',
            message: String(error.message) || 'Refresh processing error',
          },
        },
        401,
      );
    }
  };
}

/**
 * Create a new auth controller
 */
export function createAuthController(): AuthController {
  return new AuthController();
}
