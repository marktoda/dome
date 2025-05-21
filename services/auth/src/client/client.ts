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
  SupportedAuthProvider, // Import the enum
} from './types';
import { wrap } from '../utils/wrap';

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
  async login(
    providerName: SupportedAuthProvider,
    credentials: Record<string, unknown>,
  ): Promise<LoginResponse> {
    const startTime = performance.now();

    return wrap({ operation: 'login', provider: providerName }, async () => {
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
    });
  }

  /**
   * Register a new user
   */
  async register(
    providerName: SupportedAuthProvider,
    registrationData: Record<string, unknown>,
  ): Promise<RegisterResponse> {
    const startTime = performance.now();

    return wrap({ operation: 'register', provider: providerName }, async () => {
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
    });
  }

  /**
   * Validate a token
   */
  async validateToken(
    token: string,
    providerName?: SupportedAuthProvider,
  ): Promise<ValidateTokenResponse> {
    const startTime = performance.now();

    return wrap({ operation: 'validateToken', provider: providerName }, async () => {
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
    });
  }

  /**
   * Logout a user
   */
  async logout(providerName: SupportedAuthProvider, token: string): Promise<LogoutResponse> {
    const startTime = performance.now();

    return wrap({ operation: 'logout', provider: providerName }, async () => {
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
    });
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
