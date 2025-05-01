import type {
  LoginResponse,
  RegisterResponse,
  ValidateTokenResponse
} from './authTypes';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://dome-api.chatter-9999.workers.dev';

/**
 * Auth client for interacting with the auth API
 */
export const authClient = {
  /**
   * Login a user with email and password
   */
  async login(email: string, password: string): Promise<LoginResponse> {
    const response = await fetch(`${API_URL}/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email, password })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Login failed');
    }

    return response.json();
  },

  /**
   * Register a new user
   */
  async register(email: string, password: string, name?: string): Promise<RegisterResponse> {
    const response = await fetch(`${API_URL}/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email, password, name })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Registration failed');
    }

    return response.json();
  },

  /**
   * Validate a token
   */
  async validateToken(token: string): Promise<ValidateTokenResponse> {
    const response = await fetch(`${API_URL}/auth/validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Token validation failed');
    }

    return response.json();
  },

  /**
   * Logout a user
   */
  async logout(token: string): Promise<{ success: boolean }> {
    const response = await fetch(`${API_URL}/auth/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Logout failed');
    }

    return response.json();
  }
};