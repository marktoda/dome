import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { BaseError, UnauthorizedError, ValidationError, ServiceError, NotFoundError, ForbiddenError, createServiceErrorHandler } from '@dome/common/errors';
import { getLogger, logError, withContext } from '@dome/common';
import { authMetrics } from './utils/logging';
import { LoginResponse, RegisterResponse, ValidateTokenResponse, LogoutResponse, SupportedAuthProvider, User } from './types'; // Added User
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

// Define Env if not already globally available or imported
// This should match the Env used by WorkerEntrypoint<Env>
interface Env {
  AUTH_DB: any; // D1Database, etc.
  // Expected environment variables for providers, JWT secrets, etc.
  [key: string]: any;
}

const authToDomeError = createServiceErrorHandler('auth');

/**
 * Run a function with enhanced logging and error handling for RPC.
 * For Hono, error handling will be managed by its middleware.
 * @param meta Metadata for logging context
 * @param fn Function to execute
 * @returns Result of the function
 */
const runRpcWithLog = <T>(meta: Record<string, unknown>, fn: () => Promise<T>): Promise<T> =>
  withContext(meta, async () => { // logger instance is available via getLogger() from context
    const logger = getLogger();
    try {
      return await fn();
    } catch (err) {
      const requestId = typeof meta.requestId === 'string' ? meta.requestId : undefined;
      const operation = typeof meta.op === 'string' ? meta.op : 'unknown_operation';

      const errorContext = {
        operation,
        requestId,
        service: 'auth',
        timestamp: new Date().toISOString(),
        ...meta,
      };

      // Log the original error structure
      logError(err, `Error in RPC operation ${operation}`, { errorContext });

      if (err instanceof BaseError) {
        // If it's already a BaseError, it's structured for our system
        throw err; // Propagate it as is for RPC handler to format
      }

      // Convert unknown errors to a generic ServiceError or use authToDomeError
      const domeError = authToDomeError(err, `RPC ${operation} failed`);
      throw domeError;
    }
  });

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
      throw authToDomeError(new Error('AUTH_DB is not configured.'), 'AUTH_DB configuration error', { code: 'AUTH_CONFIG_ERROR', httpStatus: 500 });
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
      logger.warn('No auth providers are enabled or configured. Auth service may not function correctly.');
    } else {
      logger.info({ enabledProviders: Array.from(activeProviders.keys()) }, 'Auth providers initialized.');
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

    // Hono Error Handler
    this.honoApp.onError((err, c) => {
      const logger = getLogger();
      logger.error({ error: err, path: c.req.path, method: c.req.method }, 'Hono API Error');
      if (err instanceof BaseError) {
        return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as any);
      }
      const domeError = authToDomeError(err, 'An unexpected API error occurred');
      return c.json({ error: { code: domeError.code, message: domeError.message, details: domeError.details } }, domeError.status as any);
    });

    // Define Hono HTTP Routes (details in next step)
    this.setupHttpRoutes();
  }

  private setupHttpRoutes() {
    // /login
    this.honoApp.post('/login', async (c) => {
      const body = await c.req.json<{ providerName: string; credentials: Record<string, unknown> }>();
      if (!body.providerName || !body.credentials) {
        throw new ValidationError('providerName and credentials are required.');
      }
      const result = await this.unifiedAuthService.login(body.providerName, body.credentials);
      const response: LoginResponse = {
        success: true,
        user: result.user,
        token: result.tokenInfo.token,
        tokenType: result.tokenInfo.type,
        expiresAt: result.tokenInfo.expiresAt, // This is now a Unix timestamp (number)
        provider: body.providerName,
      };
      return c.json(response);
    });

    // /register
    this.honoApp.post('/register', async (c) => {
      const body = await c.req.json<{ providerName: string; registrationData: Record<string, unknown> }>();
      if (!body.providerName || !body.registrationData) {
        throw new ValidationError('providerName and registrationData are required.');
      }
      const result = await this.unifiedAuthService.register(body.providerName, body.registrationData);
      const response: RegisterResponse = {
        success: true,
        user: result.user,
        token: result.tokenInfo.token,
        tokenType: result.tokenInfo.type,
        expiresAt: result.tokenInfo.expiresAt, // This is now a Unix timestamp (number)
        provider: body.providerName,
      };
      return c.json(response);
    });

    // /validate
    this.honoApp.post('/validate', async (c) => {
      const body = await c.req.json<{ token: string; providerName?: string }>();
      if (!body.token) {
        throw new ValidationError('token is required.');
      }
      // Cast the incoming string providerName to the enum type
      const providerEnum = body.providerName as SupportedAuthProvider | undefined;
      const result = await this.unifiedAuthService.validateToken(body.token, providerEnum);
      const response: ValidateTokenResponse = {
        success: true, // Assuming validateToken throws on failure
        userId: result.userId,
        provider: result.provider,
        details: result.details,
        // ttl needs to be derived if available in details
      };
      return c.json(response);
    });

    // /logout
    this.honoApp.post('/logout', async (c) => {
      const body = await c.req.json<{ providerName: string; token: string }>();
      if (!body.providerName || !body.token) {
        throw new ValidationError('providerName and token are required.');
      }
      await this.unifiedAuthService.logout(body.token, body.providerName);
      const response: LogoutResponse = { success: true };
      return c.json(response);
    });

    // Health check
    this.honoApp.get('/health', (c) => c.text('OK'));
  }


  /**
   * RPC method: Login a user
   *
   * @param email User email
   * @param password User password
   * @returns Login result with user and token
   */
  // --- Updated RPC Methods ---
  public async login(providerName: string, credentials: Record<string, unknown>): Promise<LoginResponse> {
    const requestId = crypto.randomUUID();
    return runRpcWithLog(
      { service: 'auth', op: 'rpcLogin', providerName, requestId },
      async () => {
        authMetrics.counter('rpc.login.requests', 1, { providerName });
        getLogger().info({ providerName, requestId, operation: 'rpcLogin' }, 'Processing RPC login request');

        const result = await this.unifiedAuthService.login(providerName, credentials);

        authMetrics.counter('rpc.login.success', 1, { providerName });
        getLogger().info({ userId: result.user.id, providerName, requestId, operation: 'rpcLogin' }, 'RPC Login successful');

        return {
          success: true,
          user: result.user,
          token: result.tokenInfo.token,
          tokenType: result.tokenInfo.type,
          expiresAt: result.tokenInfo.expiresAt, // This is now a Unix timestamp (number)
          provider: providerName,
        };
      },
    );
  }

  /**
   * RPC method: Register a new user
   *
   * @param email User email
   * @param password User password
   * @param name Optional user name
   * @returns Registration result with user
   */
  public async register(providerName: string, registrationData: Record<string, unknown>): Promise<RegisterResponse> {
    const requestId = crypto.randomUUID();
    return runRpcWithLog(
      { service: 'auth', op: 'rpcRegister', providerName, requestId },
      async () => {
        authMetrics.counter('rpc.register.requests', 1, { providerName });
        getLogger().info({ providerName, requestId, operation: 'rpcRegister' }, 'Processing RPC register request');

        const result = await this.unifiedAuthService.register(providerName, registrationData);

        authMetrics.counter('rpc.register.success', 1, { providerName });
        getLogger().info({ userId: result.user.id, providerName, requestId, operation: 'rpcRegister' }, 'RPC Registration successful');
        return {
          success: true,
          user: result.user,
          token: result.tokenInfo.token,
          tokenType: result.tokenInfo.type,
          expiresAt: result.tokenInfo.expiresAt, // This is now a Unix timestamp (number)
          provider: providerName,
        };
      },
    );
  }

  /**
   * RPC method: Validate a token
   *
   * @param token JWT token to validate
   * @returns Validation result with user info
   */
  public async validateToken(token: string, providerName?: string): Promise<ValidateTokenResponse> {
    const requestId = crypto.randomUUID();
    return runRpcWithLog(
      { service: 'auth', op: 'rpcValidateToken', providerName, requestId },
      async () => {
        authMetrics.counter('rpc.validateToken.requests', 1, { providerName: providerName || 'unknown' });
        getLogger().info({ providerName, requestId, operation: 'rpcValidateToken' }, 'Processing RPC validateToken request');

        const providerEnum = providerName as SupportedAuthProvider | undefined;
        const result = await this.unifiedAuthService.validateToken(token, providerEnum);

        authMetrics.counter('rpc.validateToken.success', 1, { providerName: providerName || 'unknown' });
        getLogger().info({ userId: result.userId, provider: result.provider, requestId, operation: 'rpcValidateToken' }, 'RPC Token validation successful');

        return {
          success: true, // Assuming validateToken throws on failure
          userId: result.userId,
          provider: result.provider,
          details: result.details,
          // ttl needs to be derived
        };
      },
    );
  }

  /**
   * RPC method: Logout a user
   *
   * @param token JWT token to invalidate
   * @returns Logout result
   */
  public async logout(providerName: string, token: string): Promise<LogoutResponse> {
    const requestId = crypto.randomUUID();
    return runRpcWithLog(
      { service: 'auth', op: 'rpcLogout', providerName, requestId },
      async () => {
        authMetrics.counter('rpc.logout.requests', 1, { providerName });
        getLogger().info({ providerName, requestId, operation: 'rpcLogout' }, 'Processing RPC logout request');

        await this.unifiedAuthService.logout(token, providerName);

        authMetrics.counter('rpc.logout.success', 1, { providerName });
        getLogger().info({ providerName, requestId, operation: 'rpcLogout' }, 'RPC Logout successful');
        return { success: true };
      },
    );
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
