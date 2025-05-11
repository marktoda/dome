import { WorkerEntrypoint } from 'cloudflare:workers';
import { getLogger, initLogging, logError } from '@dome/common';
import { withContext } from '@dome/common';
import { authMetrics, trackOperation } from './utils/logging';
import { LoginResponse, RegisterResponse, ValidateTokenResponse, LogoutResponse, ValidatePrivyTokenResponse } from './types';
import { AuthService } from './services/authService';
import { PrivyAuthService } from './services/privyAuthService';
import { AuthError, AuthErrorType } from './utils/errors';
import { StatusCode } from 'hono/utils/http-status';

/**
 * Run a function with enhanced logging and error handling
 * @param meta Metadata for logging context
 * @param fn Function to execute
 * @returns Result of the function
 */
const runWithLog = <T>(meta: Record<string, unknown>, fn: () => Promise<T>): Promise<T> =>
  withContext(meta, async logger => {
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

      getLogger().error({ error: err }, `Unhandled error in ${operation}`, errorContext);

      if (err instanceof AuthError) {
        throw err;
      }

      // Convert unknown errors to AuthError
      throw new AuthError(
        err instanceof Error ? err.message : 'Unknown error',
        AuthErrorType.INTERNAL_ERROR,
        500,
      );
    }
  });

/**
 * Auth service implementation
 *
 * This service provides authentication functionality as a WorkerEntrypoint
 * so it can be consumed by other services via RPC.
 */
export default class Auth extends WorkerEntrypoint<Env> {
  /** Auth service instance */
  private _authService?: AuthService;
  /** Privy Auth service instance */
  private _privyAuthService?: PrivyAuthService;

  /** Lazily create the auth service */
  private get authService() {
    if (!this._authService) {
      this._authService = new AuthService(this.env);
    }
    return this._authService;
  }

  /** Lazily create the privy auth service */
  private get privyAuthService() {
    if (!this._privyAuthService) {
      this._privyAuthService = new PrivyAuthService(this.env);
    }
    return this._privyAuthService;
  }

  /**
   * RPC method: Login a user
   *
   * @param email User email
   * @param password User password
   * @returns Login result with user and token
   */
  public async login(email: string, password: string): Promise<LoginResponse> {
    const requestId = crypto.randomUUID();

    return runWithLog(
      {
        service: 'auth',
        op: 'login',
        email,
        requestId,
      },
      async () => {
        try {
          // Validate inputs
          if (!email || !password) {
            throw new AuthError(
              'Email and password are required',
              AuthErrorType.INVALID_CREDENTIALS,
              400,
            );
          }

          // Track request metrics
          authMetrics.counter('rpc.login.requests', 1);

          getLogger().info(
            { email, requestId, operation: 'login' },
            'Processing RPC login request',
          );

          // Perform login
          const result = await this.authService.login(email, password);

          // Track success metrics
          authMetrics.counter('rpc.login.success', 1);

          getLogger().info(
            { userId: result.user.id, email, requestId, operation: 'login' },
            'Login successful',
          );

          return result;
        } catch (error) {
          // Track failure metrics
          authMetrics.counter('rpc.login.errors', 1);

          getLogger().error({ error, email, requestId, operation: 'login' }, 'Login failed');

          throw error;
        }
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
  public async register(email: string, password: string, name?: string): Promise<RegisterResponse> {
    const requestId = crypto.randomUUID();

    return runWithLog(
      {
        service: 'auth',
        op: 'register',
        email,
        requestId,
      },
      async () => {
        try {
          // Validate inputs
          if (!email || !password) {
            throw new AuthError(
              'Email and password are required',
              AuthErrorType.REGISTRATION_FAILED,
              400,
            );
          }

          // Track request metrics
          authMetrics.counter('rpc.register.requests', 1);

          getLogger().info(
            { email, hasName: !!name, requestId, operation: 'register' },
            'Processing RPC register request',
          );

          // Perform registration
          const user = await this.authService.register(email, password, name);

          // Track success metrics
          authMetrics.counter('rpc.register.success', 1);

          getLogger().info(
            { userId: user.id, email, requestId, operation: 'register' },
            'Registration successful',
          );

          return {
            success: true,
            user,
          };
        } catch (error) {
          // Track failure metrics
          authMetrics.counter('rpc.register.errors', 1);

          logError(error, 'Registration failed', { email, requestId, operation: 'register' });

          throw error;
        }
      },
    );
  }

  /**
   * RPC method: Validate a token
   *
   * @param token JWT token to validate
   * @returns Validation result with user info
   */
  public async validateToken(token: string): Promise<ValidateTokenResponse> {
    const requestId = crypto.randomUUID();

    return runWithLog(
      {
        service: 'auth',
        op: 'validateToken',
        requestId,
      },
      async () => {
        try {
          // Validate inputs
          if (!token) {
            throw new AuthError('Token is required', AuthErrorType.MISSING_TOKEN, 401);
          }

          // Track request metrics
          authMetrics.counter('rpc.validateToken.requests', 1);

          getLogger().info(
            { requestId, operation: 'validateToken' },
            'Processing RPC validateToken request',
          );

          // Validate token
          const validationResult = await this.authService.validateToken(token);

          if (validationResult.success && validationResult.user) {
            // Track success metrics
            authMetrics.counter('rpc.validateToken.success', 1);
            getLogger().info(
              { userId: validationResult.user.id, requestId, operation: 'validateToken' },
              'Token validation successful',
            );
          } else {
            // Track failure metrics (already done by the catch block if an error is thrown)
            // but good to log here if validateToken returns success:false
            authMetrics.counter('rpc.validateToken.failure', 1);
            getLogger().warn(
              { requestId, operation: 'validateToken', reason: 'Validation_failed_no_error' },
              'Token validation returned success: false',
            );
          }
          return validationResult;
        } catch (error) {
          // Track failure metrics
          authMetrics.counter('rpc.validateToken.errors', 1);

          getLogger().error(
            { error, requestId, operation: 'validateToken' },
            'Token validation failed',
          );

          throw error;
        }
      },
    );
  }

  /**
   * RPC method: Logout a user
   *
   * @param token JWT token to invalidate
   * @returns Logout result
   */
  public async logout(token: string): Promise<LogoutResponse> {
    const requestId = crypto.randomUUID();

    return runWithLog(
      {
        service: 'auth',
        op: 'logout',
        requestId,
      },
      async () => {
        try {
          // Validate inputs
          if (!token) {
            throw new AuthError('Token is required', AuthErrorType.MISSING_TOKEN, 401);
          }

          // Track request metrics
          authMetrics.counter('rpc.logout.requests', 1);

          // Get user ID for logging before invalidating token
          let userId: string = 'unknown';
          try {
            // We call validateToken to get user.id for logging,
            // but logout should proceed even if token is already invalid.
            const validationResult = await this.authService.validateToken(token);
            if (validationResult.success && validationResult.user) {
              userId = validationResult.user.id;
            }
          } catch (e) {
            // Continue with logout even if token validation throws an error
          }

          getLogger().info(
            { userId, requestId, operation: 'logout' },
            'Processing RPC logout request',
          );

          // Perform logout
          const success = await this.authService.logout(token, userId);

          // Track success metrics
          authMetrics.counter('rpc.logout.success', 1);

          getLogger().info({ userId, success, requestId, operation: 'logout' }, 'Logout completed');

          return { success };
        } catch (error) {
          // Track failure metrics
          authMetrics.counter('rpc.logout.errors', 1);

          getLogger().error({ error, requestId, operation: 'logout' }, 'Logout failed');

          throw error;
        }
      },
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const logger = getLogger();
    const requestId = crypto.randomUUID(); // For logging within this request

    // Initialize logging for the request context if needed by @dome/common setup
    // Assuming initLogging might take env and request, or just set up a global context
    // If ctx is needed by initLogging, this might need adjustment based on WorkerEntrypoint capabilities
    // For now, let's assume initLogging can work with this.env and request, or is handled by withContext
    // initLogging(this.env, request); // This call needs to be verified based on @dome/common

    // It seems initLogging might be implicitly handled by withContext or a similar mechanism
    // For direct HTTP fetch, we might need a similar wrapper or ensure logger is request-scoped.
    // The runWithLog function is used for RPC, let's adapt its pattern or use a simpler log for now.

    logger.info({ path: url.pathname, method: request.method, requestId }, 'Received HTTP request');

    if (request.method === 'POST' && url.pathname === '/validate') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        logger.warn({ requestId, path: url.pathname }, 'Missing or malformed Authorization header');
        return new Response(JSON.stringify({ error: 'Missing or malformed Authorization header' }), {
          status: 401, // StatusCode.UNAUTHORIZED
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const token = authHeader.substring(7); // Remove "Bearer " prefix

      try {
        // Using runWithLog to ensure consistent error handling and context logging
        return await runWithLog({ op: 'httpValidatePrivyToken', requestId, path: url.pathname }, async () => {
          const result = await this.privyAuthService.validatePrivyToken(token);
          if (result.success && result.user) {
            logger.info({ requestId, userId: result.user.id, path: url.pathname }, 'Privy token validation successful via HTTP');
          } else {
            logger.warn({ requestId, path: url.pathname, success: result.success }, 'Privy token validation failed via HTTP');
          }
          return new Response(JSON.stringify(result), {
            status: result.success ? 200 : 401, // StatusCode.OK or StatusCode.UNAUTHORIZED
            headers: { 'Content-Type': 'application/json' },
          });
        });
      } catch (error) {
        // runWithLog should handle logging and re-throwing AuthError
        // This catch block is for errors not caught by runWithLog or if runWithLog itself fails
        // but typically runWithLog converts errors to AuthError or re-throws them.
        logger.error({ error, requestId, path: url.pathname }, 'Privy token validation failed via HTTP (outer catch)');
        if (error instanceof AuthError) {
          return new Response(JSON.stringify(error.toJSON()), {
            status: error.status,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ error: 'Internal server error' }), {
          status: 500, // StatusCode.INTERNAL_SERVER_ERROR
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    if (url.pathname === '/health') {
      return new Response('OK', { status: 200 }); // StatusCode.OK
    }
    
    logger.warn({ path: url.pathname, requestId }, 'Not found');
    return new Response('Not found', { status: 404 }); // StatusCode.NOT_FOUND
  }
}
