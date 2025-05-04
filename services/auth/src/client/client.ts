/**
 * Auth Client Implementation
 *
 * A client for interacting with the Auth service using WorkerEntrypoint RPC
 */
import { getLogger, metrics } from '@dome/common';
import {
  AuthBinding, 
  AuthService, 
  LoginResponse,
  RegisterResponse,
  ValidateTokenResponse,
  LogoutResponse,
  AuthErrorCode
} from './types';

/**
 * Client for interacting with the Auth service
 * Provides methods for user authentication
 */
export class AuthClient implements AuthService {
  private logger = getLogger().child({ service: 'auth-client' });

  /**
   * Create a new AuthClient
   * @param binding The Cloudflare Worker binding to the Auth service
   * @param metricsPrefix Optional prefix for metrics (defaults to 'auth.client')
   */
  constructor(
    private readonly binding: AuthBinding,
    private readonly metricsPrefix: string = 'auth.client',
  ) { }

  /**
   * Login a user
   */
  async login(email: string, password: string): Promise<LoginResponse> {
    const startTime = performance.now();

    try {
      this.logger.info({
        event: 'login',
        email
      }, 'User login');

      const result = await this.binding.login(email, password);

      metrics.gauge(`${this.metricsPrefix}.login.latency_ms`, performance.now() - startTime);
      metrics.increment(`${this.metricsPrefix}.login.success`);

      return result;
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.login.error`);
      this.logger.error({ error, email }, 'Error during login');
      throw error;
    }
  }

  /**
   * Register a new user
   */
  async register(email: string, password: string, name?: string): Promise<RegisterResponse> {
    const startTime = performance.now();

    try {
      this.logger.info({
        event: 'register',
        email
      }, 'User registration');

      const result = await this.binding.register(email, password, name);

      metrics.gauge(`${this.metricsPrefix}.register.latency_ms`, performance.now() - startTime);
      metrics.increment(`${this.metricsPrefix}.register.success`);

      return result;
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.register.error`);
      this.logger.error({ error, email }, 'Error during registration');
      throw error;
    }
  }

  /**
   * Validate a token
   */
  async validateToken(token: string): Promise<ValidateTokenResponse> {
    const startTime = performance.now();

    try {
      this.logger.info({
        event: 'validate_token'
      }, 'Validating auth token');

      const result = await this.binding.validateToken(token);

      metrics.gauge(`${this.metricsPrefix}.validate_token.latency_ms`, performance.now() - startTime);
      metrics.increment(`${this.metricsPrefix}.validate_token.success`);

      return result;
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.validate_token.error`);
      this.logger.error({ error }, 'Error validating token');
      throw error;
    }
  }

  /**
   * Logout a user
   */
  async logout(token: string): Promise<LogoutResponse> {
    const startTime = performance.now();

    try {
      this.logger.info({
        event: 'logout'
      }, 'User logout');

      const result = await this.binding.logout(token);

      metrics.gauge(`${this.metricsPrefix}.logout.latency_ms`, performance.now() - startTime);
      metrics.increment(`${this.metricsPrefix}.logout.success`);

      return result;
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.logout.error`);
      this.logger.error({ error }, 'Error during logout');
      throw error;
    }
  }
}

/**
 * Create a new AuthClient
 * @param binding The Cloudflare Worker binding to the Auth service
 * @param metricsPrefix Optional prefix for metrics (defaults to 'auth.client')
 * @returns A new AuthClient instance
 */
export function createAuthClient(
  binding: AuthBinding,
  metricsPrefix?: string,
): AuthClient {
  return new AuthClient(binding, metricsPrefix);
}
