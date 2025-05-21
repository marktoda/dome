import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { BaseError, createServiceErrorHandler, errorHandler } from '@dome/common/errors';
import { getLogger } from '@dome/common';
import { authMetrics } from './utils/logging';
import {
  LoginResponse,
  RegisterResponse,
  ValidateTokenResponse,
  LogoutResponse,
  SupportedAuthProvider,
  User,
} from './types'; // Added User
import { AuthService as UnifiedAuthService } from './services/auth-service';
import { UserManager } from './services/user/user-manager';
import { BaseAuthProvider } from './services/providers/base-auth-provider'; // Corrected import
import { getAuthProvidersConfig } from './config/auth-config'; // Corrected path
import { JwtTokenManager } from './services/token/token-manager'; // Use concrete class
import { getTokenSettings } from './config/token-config'; // For JwtTokenManager
import { DefaultProviderRegistry } from './services/providers/provider-registry'; // Use concrete class
import { LocalAuthProvider } from './services/providers/local-auth-provider';
import { PrivyAuthProvider } from './services/providers/privy-auth-provider';
// import { GoogleAuthProvider } from './services/providers/google-auth-provider'; // Example for future
// import { GitHubAuthProvider } from './services/providers/github-auth-provider'; // Example for future
import { registerRoutes } from './controllers/routes';
import * as rpcHandlers from './controllers/rpc';

// Define Env if not already globally available or imported
// This should match the Env used by WorkerEntrypoint<Env>
export interface Env {
  AUTH_DB: any; // D1Database, etc.
  // Expected environment variables for providers, JWT secrets, etc.
  [key: string]: any;
}

const authToDomeError = createServiceErrorHandler('auth');

/**
 * Helper to run RPC methods with standardized context and error handling.
 */

/**
 * Auth service implementation
 *
 * This service provides authentication functionality as a WorkerEntrypoint
 * for RPC and an HTTP API via Hono.
 */
export default class Auth extends WorkerEntrypoint<Env> {
  private unifiedAuthService: UnifiedAuthService;
  private honoApp: Hono<{ Bindings: Env }>;

  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, env);
    const logger = getLogger(); // Ensure logger is available
    logger.info('Auth service constructor started.');

    // Initialize UserManager and TokenManager
    if (!env.AUTH_DB) {
      logger.error('AUTH_DB environment variable is not set. UserManager cannot be initialized.');
      // Use the authToDomeError helper
      throw authToDomeError(
        new Error('AUTH_DB is not configured.'),
        'AUTH_DB configuration error',
        { code: 'AUTH_CONFIG_ERROR', httpStatus: 500 },
      );
    }
    const userManager = new UserManager(); // Corrected: UserManager takes no arguments
    const tokenManager = new JwtTokenManager(getTokenSettings(env));

    // Get all provider configurations
    const authProviderConfigs = getAuthProvidersConfig(env);
    logger.info({ authProviderConfigs }, 'Loaded auth provider configurations.');

    const activeProviders = new Map<SupportedAuthProvider, BaseAuthProvider>(); // Corrected Map type

    // Initialize LocalAuthProvider (Email/Password)
    const localConfig = authProviderConfigs[SupportedAuthProvider.LOCAL];
    if (localConfig?.isEnabled) {
      logger.info(`Initializing LocalAuthProvider for ${SupportedAuthProvider.LOCAL}`);
      // Assuming LocalAuthProvider constructor is refactored: (config, tokenManager, userManager, env)
      // and it calls super(tokenManager) and sets its providerName.
      activeProviders.set(
        SupportedAuthProvider.LOCAL,
        new LocalAuthProvider(localConfig, tokenManager, userManager, env),
      );
    } else {
      logger.info(`LocalAuthProvider (${SupportedAuthProvider.LOCAL}) is not enabled.`);
    }

    // Initialize PrivyAuthProvider
    // Assuming Privy config is identified by env.PRIVY_APP_ID and a general enable flag
    if (env.AUTH_PRIVY_ENABLED === 'true' && env.PRIVY_APP_ID) {
      logger.info(`Initializing PrivyAuthProvider`);
      const privyConfig = { appId: env.PRIVY_APP_ID, jwksUri: env.PRIVY_JWKS_URI }; // Construct config
      // Assuming PrivyAuthProvider constructor is refactored: (config, tokenManager, userManager, env)
      activeProviders.set(
        SupportedAuthProvider.PRIVY,
        new PrivyAuthProvider(privyConfig, tokenManager, userManager, env),
      );
    } else {
      logger.info(`PrivyAuthProvider not enabled or PRIVY_APP_ID is missing.`);
    }

    // TODO: Add GoogleAuthProvider and GitHubAuthProvider initialization similarly
    // const googleConfig = authProviderConfigs[SupportedAuthProvider.GOOGLE];
    // if (googleConfig?.isEnabled && googleConfig.clientId && googleConfig.clientSecret) { ... }

    // const githubConfig = authProviderConfigs[SupportedAuthProvider.GITHUB];
    // if (githubConfig?.isEnabled && githubConfig.clientId && githubConfig.clientSecret) { ... }

    if (activeProviders.size === 0) {
      logger.warn(
        'No auth providers are enabled or configured. Auth service may not function correctly.',
      );
    } else {
      logger.info(
        { enabledProviders: Array.from(activeProviders.keys()) },
        'Auth providers initialized.',
      );
    }

    // The ProviderRegistry is not directly passed to AuthService if AuthService expects a map.
    // However, if AuthService was refactored to take ProviderRegistry:
    // const providerRegistry = new DefaultProviderRegistry();
    // activeProviders.forEach(provider => providerRegistry.registerProvider(provider));

    // UnifiedAuthService (AuthService) expects dependencies as per its AuthServiceDependencies interface.
    // Current AuthServiceDependencies: { userManager, providerServices: Map<string, BaseAuthProvider> }
    // If AuthService needs tokenManager and env, its definition and dependencies interface must be updated.
    this.unifiedAuthService = new UnifiedAuthService({
      userManager,
      providerServices: activeProviders, // Pass the map of providers
      tokenManager, // Assuming AuthServiceDependencies is updated to accept this
      env, // Assuming AuthServiceDependencies is updated to accept this
    });
    logger.info('UnifiedAuthService initialized.');

    // Initialize Hono App
    this.honoApp = new Hono<{ Bindings: Env }>().basePath('/auth');

    // Hono Middleware
    this.honoApp.use('*', cors()); // Basic CORS for all routes
    // Add a request logger middleware (simplified)
    this.honoApp.use('*', async (c, next) => {
      const logger = getLogger(); // Assuming getLogger works within Hono context via withContext or similar
      logger.info({ method: c.req.method, path: c.req.path }, 'Incoming HTTP request');
      await next();
      logger.info({ status: c.res.status }, 'HTTP request processed');
    });

    // Error handler middleware
    this.honoApp.use('*', errorHandler({ errorMapper: authToDomeError }));

    registerRoutes(this.honoApp, this.unifiedAuthService);
  }

  /**
   * RPC method: Login a user
   *
   * @param email User email
   * @param password User password
   * @returns Login result with user and token
   */
  // --- Updated RPC Methods ---
  public async login(
    providerName: string,
    credentials: Record<string, unknown>,
  ): Promise<LoginResponse> {
    return rpcHandlers.login.call(this, providerName, credentials);
  }

  /**
   * RPC method: Register a new user
   *
   * @param email User email
   * @param password User password
   * @param name Optional user name
   * @returns Registration result with user
   */
  public async register(
    providerName: string,
    registrationData: Record<string, unknown>,
  ): Promise<RegisterResponse> {
    return rpcHandlers.register.call(this, providerName, registrationData);
  }

  /**
   * RPC method: Validate a token
   *
   * @param token JWT token to validate
   * @returns Validation result with user info
   */
  public async validateToken(token: string, providerName?: string): Promise<ValidateTokenResponse> {
    return rpcHandlers.validateToken.call(this, token, providerName);
  }

  /**
   * RPC method: Logout a user
   *
   * @param token JWT token to invalidate
   * @returns Logout result
   */
  public async logout(providerName: string, token: string): Promise<LogoutResponse> {
    return rpcHandlers.logout.call(this, providerName, token);
  }

  /**
   * RPC method: Refresh tokens
   *
   * @param refreshToken existing (still-valid) refresh token
   * @returns new access & refresh token pair plus user info
   */
  public async refreshToken(refreshToken: string): Promise<LoginResponse> {
    return rpcHandlers.refreshToken.call(this, refreshToken);
  }

  // fetch method signature must match WorkerEntrypoint
  async fetch(request: Request): Promise<Response> {
    // Env and ctx are available as this.env and this.ctx due to WorkerEntrypoint constructor
    // The Hono app is initialized with this.env in the constructor.
    // Hono's fetch method takes (request, Env, ExecutionContext)
    // We need to ensure the context (logger) is properly propagated if Hono handlers rely on AsyncLocalStorage.
    // This typically involves wrapping the call in withContext if not handled by Hono middleware.

    // Simplest approach: Hono app uses this.env passed during its initialization.
    // If Hono handlers use getLogger() from @dome/common, and that relies on AsyncLocalStorage,
    // then the `withContext` wrapper is crucial around the Hono app's execution.
    // For now, let's assume Hono middleware or the way getLogger is set up handles this.
    // If `getLogger()` inside Hono routes fails, this is where `withContext` would be added.
    // e.g., return withContext({ logger: getLogger(), requestId: crypto.randomUUID() /* ...other initial context */ },
    //    () => this.honoApp.fetch(request, this.env, this.ctx)
    // );
    // For now, direct call, assuming Hono's middleware or context setup is sufficient.
    return this.honoApp.fetch(request, this.env, this.ctx);
  }
}
