import { getLogger } from '@dome/logging';
import type { User, LoginResponse } from './types';

/**
 * Auth service client
 * Client for interacting with the auth service
 */
export class AuthClient {
  private baseUrl: string;
  private logger = getLogger().child({ component: 'AuthClient' });

  /**
   * Create a new auth client
   * @param baseUrl Base URL of the auth service
   */
  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  }

  /**
   * Login a user
   * @param email User email
   * @param password User password
   * @returns Login response containing user and token
   */
  async login(email: string, password: string): Promise<LoginResponse> {
    this.logger.debug({ email }, 'Logging in user');
    
    const response = await fetch(`${this.baseUrl}/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password }),
    });
    
    if (!response.ok) {
      const error = await response.json();
      this.logger.error({ error, status: response.status }, 'Login failed');
      throw new Error(`Login failed: ${response.statusText}`);
    }
    
    return await response.json();
  }

  /**
   * Register a new user
   * @param email User email
   * @param password User password
   * @param name Optional user name
   * @returns Response containing the created user
   */
  async register(email: string, password: string, name?: string): Promise<{ success: boolean; user: User }> {
    this.logger.debug({ email }, 'Registering user');
    
    const response = await fetch(`${this.baseUrl}/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password, name }),
    });
    
    if (!response.ok) {
      const error = await response.json();
      this.logger.error({ error, status: response.status }, 'Registration failed');
      throw new Error(`Registration failed: ${response.statusText}`);
    }
    
    return await response.json();
  }

  /**
   * Validate a token
   * @param token JWT token to validate
   * @returns Response containing the user if token is valid
   */
  async validateToken(token: string): Promise<{ success: boolean; user: User }> {
    this.logger.debug('Validating token');
    
    const response = await fetch(`${this.baseUrl}/validate`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    
    if (!response.ok) {
      const error = await response.json();
      this.logger.error({ error, status: response.status }, 'Token validation failed');
      throw new Error(`Token validation failed: ${response.statusText}`);
    }
    
    return await response.json();
  }

  /**
   * Logout a user
   * @param token JWT token to invalidate
   * @returns Response indicating success or failure
   */
  async logout(token: string): Promise<{ success: boolean }> {
    this.logger.debug('Logging out user');
    
    const response = await fetch(`${this.baseUrl}/logout`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    
    if (!response.ok) {
      const error = await response.json();
      this.logger.error({ error, status: response.status }, 'Logout failed');
      throw new Error(`Logout failed: ${response.statusText}`);
    }
    
    return await response.json();
  }
}