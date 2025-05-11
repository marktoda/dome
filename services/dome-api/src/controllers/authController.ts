import { Context, Hono } from 'hono';
import { z, createRoute, OpenAPIHono, RouteConfigToTypedResponse } from '@hono/zod-openapi';
import { getLogger } from '@dome/common';
import { createServiceFactory } from '../services/serviceFactory';
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
    password: z
      .string()
      .min(8)
      .openapi({
        example: 'securepassword123',
        description: "New user's password (min 8 characters)",
      }),
    name: z.string().min(1).openapi({ example: 'New User', description: "New user's full name" }),
  })
  .openapi('RegisterBody');

// Assuming registration also returns a token, similar to login
const RegisterResponseSchema = z
  .object({
    token: z
      .string()
      .openapi({
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
const UserProfileSchema = z
  .object({
    id: z.string().openapi({ example: 'user-123' }),
    email: z.string().email().openapi({ example: 'user@example.com' }),
    name: z.string().openapi({ example: 'User Name' }),
    role: z.string().openapi({ example: 'user' }),
  })
  .openapi('UserProfile');

const ValidateTokenResponseSchema = z
  .object({
    success: z.literal(true).openapi({ example: true }),
    user: UserProfileSchema,
  })
  .openapi('ValidateTokenResponse');

const validateTokenRoute = createRoute({
  method: 'post', // Or GET, depending on preference. POST is fine.
  path: '/validate', // Path is relative to the router mount point (/auth)
  summary: 'Validate Authentication Token',
  description: 'Validates the provided JWT and returns user information if valid.',
  security: [{ BearerAuth: [] }], // Indicates Bearer token authentication
  responses: {
    200: {
      description: 'Token is valid.',
      content: { 'application/json': { schema: ValidateTokenResponseSchema } },
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

      // Define an expected interface for the service response to help with type checking
      interface RegisterServiceResponse {
        success: boolean;
        token?: string; // Assuming token is optional and string
        error?: { code: string; message: string };
      }

      const result: RegisterServiceResponse = await authService.register(email, password, name);

      if (result.success && typeof result.token === 'string') {
        return c.json({ token: result.token }, 201);
      }

      if (result.error?.code === 'USER_ALREADY_EXISTS') {
        // Assuming this specific code from service
        this.logger.warn(
          { email, errorCode: result.error.code },
          'Registration attempt for existing user',
        );
        return c.json(
          {
            success: false as const,
            error: { code: 'CONFLICT', message: result.error.message || 'User already exists' },
          },
          409,
        );
      }

      this.logger.error(
        { result },
        'Registration service call failed, did not return token, or returned unexpected error',
      );
      return c.json(
        {
          success: false as const,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message:
              result.error?.message ||
              'Registration failed to produce a token or encountered an unknown issue.',
          },
        },
        500,
      );
    } catch (error: any) {
      this.logger.error(
        { errorMessage: error.message, stack: error.stack, code: error.code },
        'Registration failed with exception',
      );
      // If the caught error has a structure that indicates a specific business logic failure (e.g. user exists)
      if (error.code === 'USER_ALREADY_EXISTS') {
        // Check if service throws custom errors
        return c.json(
          {
            success: false as const,
            error: { code: 'CONFLICT', message: String(error.message) || 'User already exists' },
          },
          409,
        );
      }
      return c.json(
        {
          success: false as const,
          error: {
            code: 'BAD_REQUEST',
            message: String(error.message) || 'Registration processing error',
          },
        },
        400,
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
      interface LoginServiceResponse {
        success: boolean;
        token?: string;
        error?: { code: string; message: string };
      }
      const result: LoginServiceResponse = await authService.login(email, password);

      if (result.success && typeof result.token === 'string') {
        return c.json({ token: result.token }, 200);
      }
      this.logger.warn({ result }, 'Login service call failed or did not return token');
      return c.json(
        {
          success: false as const,
          error: {
            code: 'UNAUTHORIZED',
            message: String(result.error?.message) || 'Invalid credentials',
          },
        },
        401,
      );
    } catch (error: any) {
      this.logger.error(
        { errorMessage: error.message, stack: error.stack },
        'Login failed with exception',
      );
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
      const result: LogoutServiceResponse = await authService.logout(token);

      if (result.success) {
        return c.json({ success: true, message: 'Logout successful' }, 200);
      }
      this.logger.error({ result }, 'Logout service call failed');
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
      this.logger.error(
        { errorMessage: error.message, stack: error.stack },
        'Logout failed with exception',
      );
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

      // Define an expected interface for the service response
      interface UserProfileData {
        id: string;
        email: string;
        name?: string; // Make name optional to match service's potential return type
        role: string;
      }
      interface ValidateTokenServiceResponse {
        success: boolean;
        user?: UserProfileData; // User data is optional
        error?: { code: string; message: string }; // Error details are optional
      }

      const result: ValidateTokenServiceResponse = await authService.validateToken(token);

      if (result.success && result.user) {
        // Validate the structure of result.user against UserProfileSchema
        const validation = UserProfileSchema.safeParse(result.user);
        if (!validation.success) {
          this.logger.error(
            { errors: validation.error.flatten(), userFromService: result.user },
            'User profile from authService failed Zod validation against UserProfileSchema',
          );
          return c.json(
            {
              success: false,
              error: {
                code: 'INTERNAL_SERVER_ERROR',
                message: 'Invalid user data structure received from authentication service.',
              },
            },
            500,
          );
        }
        return c.json({ success: true, user: validation.data }, 200);
      }
      this.logger.warn(
        { result },
        'Token validation service call failed or did not return user profile',
      );
      return c.json(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: String(result.error?.message) || 'Invalid or expired token',
          },
        },
        401,
      );
    } catch (error: any) {
      this.logger.error(
        { errorMessage: error.message, stack: error.stack },
        'Token validation failed with exception',
      );
      if (error instanceof z.ZodError) {
        // This case should ideally be caught by the safeParse above.
        this.logger.error(
          { errors: error.flatten() },
          'UserProfileSchema validation failed unexpectedly during catch block.',
        );
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
}

/**
 * Create a new auth controller
 */
export function createAuthController(): AuthController {
  return new AuthController();
}
