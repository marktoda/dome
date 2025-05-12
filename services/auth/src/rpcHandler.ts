import { AuthErrorCode, AuthBinding, LoginResponse, RegisterResponse, ValidateTokenResponse, LogoutResponse } from './client/types';
import { AuthService } from './services/auth-service'; // Corrected import path
import { BaseError, UnauthorizedError, ValidationError, NotFoundError, ForbiddenError, ServiceError } from '@dome/common/errors';
import { getLogger, logError } from '@dome/common';
import { UserManager } from './services/user/user-manager';
import { BaseAuthProvider } from './services/providers/base-auth-provider'; // Corrected path
import { getAuthProvidersConfig } from './config/auth-config';
import { SupportedAuthProvider } from './types';
import { JwtTokenManager } from './services/token/token-manager';
import { getTokenSettings } from './config/token-config';
import { LocalAuthProvider } from './services/providers/local-auth-provider';
import { PrivyAuthProvider } from './services/providers/privy-auth-provider';

// Define Env to match what's used in index.ts and providers
interface Env {
  AUTH_DB: any;
  AUTH_EMAIL_ENABLED?: string;
  AUTH_PRIVY_ENABLED?: string;
  PRIVY_APP_ID?: string;
  PRIVY_JWKS_URI?: string;
  // Add other JWT and provider-specific env vars as needed
  JWT_SECRET_KEY?: string;
  REFRESH_TOKEN_SECRET_KEY?: string;
  JWT_ISSUER?: string;
  JWT_AUDIENCE?: string;
  ACCESS_TOKEN_EXPIRATION?: string;
  REFRESH_TOKEN_EXPIRATION?: string;
  [key: string]: any;
}

const logger = getLogger();

export class AuthRPCHandler implements AuthBinding {
  private authService: AuthService;

  constructor(private readonly env: Env) {
    logger.info('AuthRPCHandler constructor started.');
    if (!env.AUTH_DB) {
      logger.error('Missing AUTH_DB binding in environment for AuthRPCHandler');
      throw new ServiceError('AUTH_DB is not configured for AuthRPCHandler.', { service: 'auth', code: 'RPC_HANDLER_CONFIG_ERROR' });
    }

    const userManager = new UserManager(); // Assumes UserManager takes no args or uses env internally if needed
    const tokenManager = new JwtTokenManager(getTokenSettings(env));

    const authProviderConfigs = getAuthProvidersConfig(env);
    logger.info({ authProviderConfigs }, 'AuthRPCHandler: Loaded auth provider configurations.');

    const activeProviders = new Map<string, BaseAuthProvider>();

    // Initialize LocalAuthProvider (Email/Password)
    const localConfig = authProviderConfigs[SupportedAuthProvider.LOCAL];
    if (localConfig?.isEnabled) {
      logger.info(`AuthRPCHandler: Initializing LocalAuthProvider for ${SupportedAuthProvider.LOCAL}`);
      activeProviders.set(
        SupportedAuthProvider.LOCAL,
        new LocalAuthProvider(localConfig, tokenManager, userManager, env),
      );
    } else {
      logger.info(`AuthRPCHandler: LocalAuthProvider (${SupportedAuthProvider.LOCAL}) is not enabled.`);
    }

    // Initialize PrivyAuthProvider
    const privyProviderName = 'privy';
    if (env.AUTH_PRIVY_ENABLED === 'true' && env.PRIVY_APP_ID) {
      logger.info(`AuthRPCHandler: Initializing PrivyAuthProvider for ${privyProviderName}`);
      const privyConfig = { appId: env.PRIVY_APP_ID, jwksUri: env.PRIVY_JWKS_URI, isEnabled: true };
      activeProviders.set(
        privyProviderName,
        new PrivyAuthProvider(privyConfig, tokenManager, userManager, env),
      );
    } else {
      logger.info(`AuthRPCHandler: PrivyAuthProvider (${privyProviderName}) is not enabled or PRIVY_APP_ID is missing.`);
    }

    if (activeProviders.size === 0) {
      logger.warn('AuthRPCHandler: No auth providers are enabled or configured.');
    }

    this.authService = new AuthService({
      userManager,
      providerServices: activeProviders,
      tokenManager,
      env,
    });
    logger.info('Auth RPC Handler initialized with fully configured AuthService.');
  }

  async login(providerName: string, credentials: Record<string, unknown>): Promise<LoginResponse> {
    try {
      logger.debug('RPC: login', { providerName, credentials: Object.keys(credentials) });
      const result = await this.authService.login(providerName, credentials);
      logger.debug('RPC: login completed', { userId: result.user.id, providerName });
      return {
        success: true,
        user: result.user,
        token: result.tokenInfo.token,
        tokenType: result.tokenInfo.type,
        expiresAt: result.tokenInfo.expiresAt, // Unix timestamp in seconds
        provider: providerName,
        ...(result.tokenInfo.refreshToken && { refreshToken: result.tokenInfo.refreshToken }),
      };
    } catch (error) {
      logError(error, 'RPC: login failed', { providerName });
      throw this.formatRPCError(error);
    }
  }

  async register(providerName: string, registrationData: Record<string, unknown>): Promise<RegisterResponse> {
    try {
      logger.debug('RPC: register', { providerName, registrationData: Object.keys(registrationData) });
      const result = await this.authService.register(providerName, registrationData);
      logger.debug('RPC: register completed', { userId: result.user.id, providerName });
      return {
        success: true,
        user: result.user,
        token: result.tokenInfo.token,
        tokenType: result.tokenInfo.type,
        expiresAt: result.tokenInfo.expiresAt, // Unix timestamp in seconds
        provider: providerName,
        ...(result.tokenInfo.refreshToken && { refreshToken: result.tokenInfo.refreshToken }),
      };
    } catch (error) {
      logError(error, 'RPC: register failed', { providerName });
      throw this.formatRPCError(error);
    }
  }

  async validateToken(token: string, providerName?: string): Promise<ValidateTokenResponse> {
    try {
      logger.debug('RPC: validateToken', { providerName });
      const providerEnum = providerName as SupportedAuthProvider | undefined;
      const result = await this.authService.validateToken(token, providerEnum);
      logger.debug('RPC: validateToken completed', { userId: result.userId, provider: result.provider });
      // Assuming ttl might be part of result.details or needs to be calculated
      return {
        success: true,
        userId: result.userId,
        provider: result.provider,
        details: result.details,
        // ttl: result.details?.ttl, // Example, adjust as needed
      };
    } catch (error) {
      logError(error, 'RPC: validateToken failed');
      throw this.formatRPCError(error);
    }
  }

  async logout(providerName: string, token: string): Promise<LogoutResponse> {
    try {
      logger.debug('RPC: logout', { providerName });
      await this.authService.logout(token, providerName);
      logger.debug('RPC: logout completed', { providerName });
      return { success: true };
    } catch (error) {
      logError(error, 'RPC: logout failed', { providerName });
      // Logout failures might not always need to throw a formatted RPC error
      // depending on desired client behavior. For now, we format and throw.
      throw this.formatRPCError(error);
    }
  }

  private formatRPCError(error: unknown): Error {
    let code = AuthErrorCode.INTERNAL_ERROR;
    let message = 'An unknown error occurred';
    let details: Record<string, any> | undefined;

    if (error instanceof BaseError) {
      message = error.message;
      details = error.details;
      // Map BaseError (and its derivatives) to AuthErrorCode
      if (error instanceof UnauthorizedError) {
        code = AuthErrorCode.INVALID_TOKEN; // Or INVALID_CREDENTIALS depending on context
        if (error.message.toLowerCase().includes('credentials')) {
            code = AuthErrorCode.INVALID_CREDENTIALS;
        }
      } else if (error instanceof ValidationError) {
        // ValidationError from common/errors has code 'VALIDATION_ERROR' and status 400
        // This could map to REGISTRATION_FAILED or LOGIN_FAILED if it's a general validation issue
        // or a more specific one if details are available.
        // For now, using a generic one or checking message.
        if (message.toLowerCase().includes('registration')) {
            code = AuthErrorCode.REGISTRATION_FAILED;
        } else if (message.toLowerCase().includes('login')) {
            code = AuthErrorCode.LOGIN_FAILED;
        } else if (message.toLowerCase().includes('provider')) { // From our AuthService getProvider
            code = AuthErrorCode.INTERNAL_ERROR; // Or a new specific code like UNSUPPORTED_PROVIDER
        } else {
            code = AuthErrorCode.INVALID_CREDENTIALS; // Default for general validation
        }
      } else if (error instanceof ForbiddenError) {
        code = AuthErrorCode.INSUFFICIENT_PERMISSIONS;
      } else if (error instanceof NotFoundError) {
        code = AuthErrorCode.USER_NOT_FOUND; // Assuming NotFoundError in auth context means user not found
      } else if (error instanceof ServiceError) {
        // Generic ServiceError, could be various things.
        // Check specific codes if ServiceError has them, or use INTERNAL_ERROR
        if (error.code === 'QUEUE_ERROR' || error.code === 'MESSAGE_PROCESSING_ERROR') {
            code = AuthErrorCode.INTERNAL_ERROR; // Or a more specific mapping if relevant
        }
      }
      // Add more specific mappings if BaseError has more distinct `code` values in your app
      // e.g. if (error.code === 'USER_ALREADY_EXISTS') code = AuthErrorCode.USER_EXISTS;

    } else if (error instanceof Error) {
      message = error.message;
    }

    const formattedError = {
      error: {
        code,
        message,
        details,
      },
    };
    // Return a new Error object with the JSON stringified error,
    // as this is how RPC errors are typically propagated by Cloudflare Workers.
    return new Error(JSON.stringify(formattedError));
  }
}
