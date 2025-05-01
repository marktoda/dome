import { getLogger } from '@dome/logging';
import { AuthClient } from './client';
import type { AuthServiceInterface, User, LoginResponse } from './types';
export * from './types';

/**
 * Auth binding for service-to-service communication
 */
export class AuthServiceBinding implements AuthServiceInterface {
  private client: AuthClient;
  private logger = getLogger().child({ component: 'AuthServiceBinding' });

  /**
   * Create a new auth service binding
   * @param serviceUrl Base URL of the auth service
   */
  constructor(serviceUrl: string) {
    this.client = new AuthClient(serviceUrl);
  }

  /**
   * Login a user
   */
  async login(email: string, password: string): Promise<LoginResponse> {
    try {
      this.logger.debug({ email }, 'Auth service login request');
      return await this.client.login(email, password);
    } catch (error) {
      this.logger.error({ error, email }, 'Auth service login failed');
      throw error;
    }
  }

  /**
   * Register a new user
   */
  async register(email: string, password: string, name?: string): Promise<{ success: boolean; user: User }> {
    try {
      this.logger.debug({ email }, 'Auth service register request');
      return await this.client.register(email, password, name);
    } catch (error) {
      this.logger.error({ error, email }, 'Auth service registration failed');
      throw error;
    }
  }

  /**
   * Validate a token
   */
  async validateToken(token: string): Promise<{ success: boolean; user: User }> {
    try {
      this.logger.debug('Auth service token validation request');
      return await this.client.validateToken(token);
    } catch (error) {
      this.logger.error({ error }, 'Auth service token validation failed');
      throw error;
    }
  }

  /**
   * Logout a user
   */
  async logout(token: string): Promise<{ success: boolean }> {
    try {
      this.logger.debug('Auth service logout request');
      return await this.client.logout(token);
    } catch (error) {
      this.logger.error({ error }, 'Auth service logout failed');
      throw error;
    }
  }
}

/**
 * For Cloudflare Worker Service Binding
 */
export interface AuthBinding {
  fetch: (request: Request, env?: any) => Promise<Response>;
}