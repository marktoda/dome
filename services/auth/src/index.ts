import { BaseWorker } from '@dome/common';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { BaseError, createServiceErrorHandler, errorHandler } from '@dome/common/errors';
import { getLogger, createServiceMetrics } from '@dome/common';

// Create service-specific metrics
const authMetrics = createServiceMetrics('auth');
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
import { loadEnv } from '@dome/common/config/env';
import { AuthEnvSchema, AuthEnv } from './config/env';
import { JwtTokenManager } from './services/token/token-manager'; // Use concrete class
import { getTokenSettings } from './config/token-config'; // For JwtTokenManager
import { LocalAuthProvider } from './services/providers/local-auth-provider';
import { PrivyAuthProvider } from './services/providers/privy-auth-provider';
// import { GoogleAuthProvider } from './services/providers/google-auth-provider'; // Example for future
// import { GitHubAuthProvider } from './services/providers/github-auth-provider'; // Example for future
import { registerRoutes } from './controllers/routes';
import * as rpcHandlers from './controllers/rpc';

// Define Env if not already globally available or imported
// This should match the Env used by BaseWorker<Env>
export type Env = AuthEnv;

const authToDomeError = createServiceErrorHandler('auth');

interface Services {
  auth: UnifiedAuthService;
}

const buildServices = (env: Env): Services => {
  const logger = getLogger();

  const userManager = new UserManager();
  const tokenManager = new JwtTokenManager(getTokenSettings(env));

  const authProviderConfigs = getAuthProvidersConfig(env);
  logger.info({ authProviderConfigs }, 'Loaded auth provider configurations.');

  const activeProviders = new Map<SupportedAuthProvider, BaseAuthProvider>();

  const localConfig = authProviderConfigs[SupportedAuthProvider.LOCAL];
  if (localConfig?.isEnabled) {
    logger.info(`Initializing LocalAuthProvider for ${SupportedAuthProvider.LOCAL}`);
    activeProviders.set(
      SupportedAuthProvider.LOCAL,
      new LocalAuthProvider(localConfig, tokenManager, userManager, env),
    );
  }

  if (env.AUTH_PRIVY_ENABLED === 'true' && env.PRIVY_APP_ID) {
    logger.info('Initializing PrivyAuthProvider');
    const privyConfig = { appId: env.PRIVY_APP_ID, jwksUri: env.PRIVY_JWKS_URI };
    activeProviders.set(
      SupportedAuthProvider.PRIVY,
      new PrivyAuthProvider(privyConfig, tokenManager, userManager, env),
    );
  }

  if (activeProviders.size === 0) {
    logger.warn('No auth providers are enabled or configured.');
  } else {
    logger.info(
      { enabledProviders: Array.from(activeProviders.keys()) },
      'Auth providers initialized.',
    );
  }

  const auth = new UnifiedAuthService({
    userManager,
    providerServices: activeProviders,
    tokenManager,
    env,
  });

  logger.info('UnifiedAuthService initialized.');

  return { auth };
};

/**
 * Helper to run RPC methods with standardized context and error handling.
 */

/**
 * Auth service implementation
 *
 * This service provides authentication functionality as a BaseWorker
 * for RPC and an HTTP API via Hono.
 */
export default class Auth extends BaseWorker<Env, ReturnType<typeof buildServices>> {
  private unifiedAuthService: UnifiedAuthService;
  private honoApp: Hono<{ Bindings: Env }>;

  constructor(ctx: ExecutionContext, env: unknown) {
    const parsedEnv = loadEnv<AuthEnv>(AuthEnvSchema, env);
    super(ctx, parsedEnv, buildServices, { serviceName: 'auth' });

    this.unifiedAuthService = this.services.auth;

    this.honoApp = new Hono<{ Bindings: Env }>().basePath('/auth');
    this.honoApp.use('*', cors());
    this.honoApp.use('*', async (c, next) => {
      const logger = getLogger();
      logger.info({ method: c.req.method, path: c.req.path }, 'Incoming HTTP request');
      await next();
      logger.info({ status: c.res.status }, 'HTTP request processed');
    });

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

  // fetch method signature must match BaseWorker
  async fetch(request: Request): Promise<Response> {
    // Env and ctx are available as this.env and this.ctx due to BaseWorker constructor
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
