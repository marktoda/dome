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
  AuthErrorCode,
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
  ) {}

  /**
   * Login a user
   */
  async login(providerName: string, credentials: Record<string, unknown>): Promise<LoginResponse> {
    const startTime = performance.now();

    try {
      this.logger.info(
        {
          event: 'login',
          provider: providerName,
          credentials,
        },
        'User login',
      );

      const result = await this.binding.login(providerName, credentials);

      metrics.gauge(`${this.metricsPrefix}.login.latency_ms`, performance.now() - startTime);
      metrics.increment(`${this.metricsPrefix}.login.success`);

      return result;
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.login.error`);
      this.logger.error({ error, provider: providerName, credentials }, 'Error during login');
      throw error;
    }
  }

  /**
   * Register a new user
   */
  async register(providerName: string, registrationData: Record<string, unknown>): Promise<RegisterResponse> {
    const startTime = performance.now();

    try {
      this.logger.info(
        {
          event: 'register',
          provider: providerName,
          registrationData,
        },
        'User registration',
      );

      const result = await this.binding.register(providerName, registrationData);

      metrics.gauge(`${this.metricsPrefix}.register.latency_ms`, performance.now() - startTime);
      metrics.increment(`${this.metricsPrefix}.register.success`);

      return result;
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.register.error`);
      this.logger.error({ error, provider: providerName, registrationData }, 'Error during registration');
      throw error;
    }
  }

  /**
   * Validate a token
   */
  async validateToken(token: string, providerName?: string): Promise<ValidateTokenResponse> {
    const startTime = performance.now();

    try {
      this.logger.info(
        {
          event: 'validate_token',
          provider: providerName,
        },
        'Validating auth token',
      );

      const result = await this.binding.validateToken(token, providerName);

      metrics.gauge(
        `${this.metricsPrefix}.validate_token.latency_ms`,
        performance.now() - startTime,
      );
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
  async logout(providerName: string, token: string): Promise<LogoutResponse> {
    const startTime = performance.now();

    try {
      this.logger.info(
        {
          event: 'logout',
          provider: providerName,
        },
        'User logout',
      );

      const result = await this.binding.logout(providerName, token);

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
export function createAuthClient(binding: AuthBinding, metricsPrefix?: string): AuthClient {
  return new AuthClient(binding, metricsPrefix);
}
