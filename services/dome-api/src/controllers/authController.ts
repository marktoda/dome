import { Context } from 'hono';
import { getLogger } from '@dome/common';
import { createServiceFactory } from '../services/serviceFactory';
import type { Bindings } from '../types';

/**
 * Controller for authentication endpoints
 */
export class AuthController {
  private logger = getLogger().child({ component: 'AuthController' });

  /**
   * Register a new user
   */
  register = async (c: Context<{ Bindings: Bindings }>) => {
    try {
      const { email, password, name } = await c.req.json();
      
      this.logger.debug({ email }, 'User registration request');
      
      // Get auth service client from factory
      const serviceFactory = createServiceFactory();
      const authService = serviceFactory.getAuthService(c.env);
      
      // Register user
      const result = await authService.register(email, password, name);
      
      return c.json(result);
    } catch (error) {
      this.logger.error({ error }, 'Registration failed');
      return c.json(
        {
          success: false,
          error: {
            code: 'BAD_REQUEST',
            message: 'Registration failed',
          },
        },
        400
      );
    }
  };

  /**
   * Login a user
   */
  login = async (c: Context<{ Bindings: Bindings }>) => {
    try {
      const { email, password } = await c.req.json();
      
      this.logger.debug({ email }, 'User login request');
      
      // Get auth service client from factory
      const serviceFactory = createServiceFactory();
      const authService = serviceFactory.getAuthService(c.env);
      
      // Login user
      const result = await authService.login(email, password);
      
      return c.json(result);
    } catch (error) {
      this.logger.error({ error }, 'Login failed');
      return c.json(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Login failed',
          },
        },
        401
      );
    }
  };

  /**
   * Logout a user
   */
  logout = async (c: Context<{ Bindings: Bindings }>) => {
    try {
      const authHeader = c.req.header('Authorization');
      
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        this.logger.warn('Missing or invalid Authorization header');
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
      
      const token = authHeader.slice(7);
      
      this.logger.debug('User logout request');
      
      // Get auth service client from factory
      const serviceFactory = createServiceFactory();
      const authService = serviceFactory.getAuthService(c.env);
      
      // Logout user
      const result = await authService.logout(token);
      
      return c.json(result);
    } catch (error) {
      this.logger.error({ error }, 'Logout failed');
      return c.json(
        {
          success: false,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Logout failed',
          },
        },
        500
      );
    }
  };

  /**
   * Validate a token
   */
  validateToken = async (c: Context<{ Bindings: Bindings }>) => {
    try {
      const authHeader = c.req.header('Authorization');
      
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        this.logger.warn('Missing or invalid Authorization header');
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
      
      const token = authHeader.slice(7);
      
      this.logger.debug('Token validation request');
      
      // Get auth service client from factory
      const serviceFactory = createServiceFactory();
      const authService = serviceFactory.getAuthService(c.env);
      
      // Validate token
      const result = await authService.validateToken(token);
      
      return c.json(result);
    } catch (error) {
      this.logger.error({ error }, 'Token validation failed');
      return c.json(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Invalid token',
          },
        },
        401
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
