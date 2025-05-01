import {
  AuthErrorCode,
  AuthBinding
} from './client/types';
import { AuthService } from './services/authService';
import { getLogger } from '@dome/logging';
import { AuthError } from './utils/errors';

const logger = getLogger();

/**
 * RPC handler for the Auth service
 *
 * Implements the AuthBinding interface to expose auth methods to other services
 */
export class AuthRPCHandler implements AuthBinding {
  private authService: AuthService;

  constructor(private readonly env: Env) {
    // Ensure DB binding exists
    if (!env.AUTH_DB) {
      logger.error('Missing AUTH_DB binding in environment');
      throw new Error('Missing AUTH_DB binding. Check wrangler.toml configuration.');
    }

    // Initialize service with environment bindings
    this.authService = new AuthService(env);
    logger.info('Auth RPC Handler initialized');
  }

  /**
   * Login a user
   */
  async login(email: string, password: string) {
    try {
      logger.debug('RPC: login', { email });

      const result = await this.authService.login(email, password);

      logger.debug('RPC: login completed', {
        userId: result.user.id,
        email
      });

      return result;
    } catch (error) {
      logger.error('RPC: login failed', { error, email });
      throw this.formatRPCError(error);
    }
  }

  /**
   * Register a new user
   */
  async register(email: string, password: string, name?: string) {
    try {
      logger.debug('RPC: register', { email });

      const user = await this.authService.register(email, password, name);

      logger.debug('RPC: register completed', {
        userId: user.id,
        email
      });

      return {
        success: true,
        user
      };
    } catch (error) {
      logger.error('RPC: register failed', { error, email });
      throw this.formatRPCError(error);
    }
  }

  /**
   * Validate a token
   */
  async validateToken(token: string) {
    try {
      logger.debug('RPC: validateToken');

      const user = await this.authService.validateToken(token);

      logger.debug('RPC: validateToken completed', {
        userId: user.id
      });

      return {
        success: true,
        user
      };
    } catch (error) {
      logger.error('RPC: validateToken failed', { error });
      throw this.formatRPCError(error);
    }
  }

  /**
   * Logout a user
   */
  async logout(token: string) {
    try {
      // Get user info before logout for logging
      let userId = 'unknown';
      try {
        const user = await this.authService.validateToken(token);
        userId = user.id;
      } catch (e) {
        // If token is invalid, just continue with logout
      }

      logger.debug('RPC: logout', { userId });

      const success = await this.authService.logout(token, userId);

      logger.debug('RPC: logout completed', {
        userId,
        success
      });

      return { success };
    } catch (error) {
      logger.error('RPC: logout failed', { error });
      throw this.formatRPCError(error);
    }
  }

  /**
   * Format an error for RPC response
   */
  private formatRPCError(error: any): Error {
    // Map AuthErrorType to RPC AuthErrorCode
    let code = AuthErrorCode.INTERNAL_ERROR;
    if (error instanceof AuthError) {
      switch (error.type) {
        case 'invalid_credentials':
          code = AuthErrorCode.INVALID_CREDENTIALS;
          break;
        case 'user_not_found':
          code = AuthErrorCode.USER_NOT_FOUND;
          break;
        case 'user_exists':
          code = AuthErrorCode.USER_EXISTS;
          break;
        case 'invalid_token':
          code = AuthErrorCode.INVALID_TOKEN;
          break;
        case 'token_expired':
          code = AuthErrorCode.TOKEN_EXPIRED;
          break;
        case 'missing_token':
          code = AuthErrorCode.MISSING_TOKEN;
          break;
        case 'insufficient_permissions':
          code = AuthErrorCode.INSUFFICIENT_PERMISSIONS;
          break;
        case 'registration_failed':
          code = AuthErrorCode.REGISTRATION_FAILED;
          break;
        case 'login_failed':
          code = AuthErrorCode.LOGIN_FAILED;
          break;
      }
    }

    const message = error.message || 'An unknown error occurred';

    // Create a standardized error response
    const formattedError = {
      error: {
        code,
        message,
        details: error.details
      }
    };

    // Convert to a real Error object for proper throwing
    const rpcError = new Error(JSON.stringify(formattedError));

    return rpcError;
  }
}
