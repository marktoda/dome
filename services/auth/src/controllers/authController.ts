import { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { StatusCode } from 'hono/utils/http-status';
import { getLogger } from '@dome/logging';
import { AuthService } from '../services/authService';
import { Bindings } from '../types';
import { AuthError, AuthErrorType } from '../utils/errors';

// Helper function to convert number to Hono StatusCode
function statusCodeFromNumber(status: number): StatusCode {
  return status as StatusCode;
}

// Request validation schemas
const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

/**
 * Authentication controller
 * Handles user registration, login, and token validation
 */
export class AuthController {
  private authService: AuthService;
  private logger = getLogger().child({ component: 'AuthController' });

  /**
   * Create a new auth controller
   */
  constructor(authService: AuthService) {
    this.authService = authService;
  }

  /**
   * Register a new user
   */
  register = async (c: Context<{ Bindings: Bindings }>) => {
    try {
      const { email, password, name } = await c.req.json();
      this.logger.debug({ email }, 'User registration request');
      
      const user = await this.authService.register(email, password, name);
      
      return c.json({
        success: true,
        user,
      }, 201);
    } catch (error) {
      this.logger.error({ error }, 'Registration failed');
      
      if (error instanceof AuthError) {
        c.status(statusCodeFromNumber(error.status));
        return c.json(error.toJSON());
      }
      
      return c.json({
        success: false,
        error: {
          type: AuthErrorType.REGISTRATION_FAILED,
          message: 'Failed to register user',
        },
      }, 500);
    }
  };

  /**
   * Login a user
   */
  login = async (c: Context<{ Bindings: Bindings }>) => {
    try {
      const { email, password } = await c.req.json();
      this.logger.debug({ email }, 'User login request');
      
      const result = await this.authService.login(email, password);
      
      // Result already has 'success: true' from the authService
      return c.json(result);
    } catch (error) {
      this.logger.error({ error }, 'Login failed');
      
      if (error instanceof AuthError) {
        c.status(statusCodeFromNumber(error.status));
        return c.json(error.toJSON());
      }
      
      return c.json({
        success: false,
        error: {
          type: AuthErrorType.LOGIN_FAILED,
          message: 'Login failed',
        },
      }, 500);
    }
  };

  /**
   * Validate a token
   */
  validateToken = async (c: Context<{ Bindings: Bindings }>) => {
    try {
      const authHeader = c.req.header('Authorization');
      
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new AuthError('Missing token', AuthErrorType.MISSING_TOKEN);
      }
      
      const token = authHeader.slice(7);
      this.logger.debug('Token validation request');
      
      const user = await this.authService.validateToken(token);
      
      return c.json({
        success: true,
        user,
      });
    } catch (error) {
      this.logger.error({ error }, 'Token validation failed');
      
      if (error instanceof AuthError) {
        c.status(statusCodeFromNumber(error.status));
        return c.json(error.toJSON());
      }
      
      return c.json({
        success: false,
        error: {
          type: AuthErrorType.INVALID_TOKEN,
          message: 'Token validation failed',
        },
      }, 401);
    }
  };

  /**
   * Logout a user
   */
  logout = async (c: Context<{ Bindings: Bindings }>) => {
    try {
      const authHeader = c.req.header('Authorization');
      
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new AuthError('Missing token', AuthErrorType.MISSING_TOKEN);
      }
      
      const token = authHeader.slice(7);
      
      // Extract user ID from token
      const user = await this.authService.validateToken(token);
      this.logger.debug({ userId: user.id }, 'User logout request');
      
      const success = await this.authService.logout(token, user.id);
      
      if (!success) {
        return c.json({
          success: false,
          error: {
            message: 'Logout failed',
          },
        }, 500);
      }
      
      return c.json({
        success: true,
        message: 'Logged out successfully',
      });
    } catch (error) {
      this.logger.error({ error }, 'Logout failed');
      
      if (error instanceof AuthError) {
        c.status(statusCodeFromNumber(error.status));
        return c.json(error.toJSON());
      }
      
      return c.json({
        success: false,
        error: {
          message: 'Logout failed',
        },
      }, 500);
    }
  };
}

/**
 * Create a new auth controller instance
 */
export function createAuthController(authService: AuthService): AuthController {
  return new AuthController(authService);
}