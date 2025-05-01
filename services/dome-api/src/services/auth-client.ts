/**
 * Temporary client for auth service
 * To be replaced by proper @dome/auth/client module
 */

// Define types for auth service responses
export interface AuthResponse {
  success: boolean;
  error?: {
    code: string;
    message: string;
  };
  user?: {
    id: string;
    role: string;
    email: string;
  };
  token?: string;
}

export class AuthServiceBinding {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  /**
   * Register a new user
   */
  async register(email: string, password: string, name: string): Promise<AuthResponse> {
    try {
      const response = await fetch(`${this.baseUrl}/auth/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ email, password, name })
      });

      return await response.json();
    } catch (error) {
      console.error('Auth registration error:', error);
      return {
        success: false,
        error: {
          code: 'AUTH_ERROR',
          message: 'Failed to register user'
        }
      };
    }
  }

  /**
   * Login a user
   */
  async login(email: string, password: string): Promise<AuthResponse> {
    try {
      const response = await fetch(`${this.baseUrl}/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ email, password })
      });

      return await response.json();
    } catch (error) {
      console.error('Auth login error:', error);
      return {
        success: false,
        error: {
          code: 'AUTH_ERROR',
          message: 'Failed to login'
        }
      };
    }
  }

  /**
   * Logout a user
   */
  async logout(token: string): Promise<AuthResponse> {
    try {
      const response = await fetch(`${this.baseUrl}/auth/logout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        }
      });

      return await response.json();
    } catch (error) {
      console.error('Auth logout error:', error);
      return {
        success: false,
        error: {
          code: 'AUTH_ERROR',
          message: 'Failed to logout'
        }
      };
    }
  }

  /**
   * Validate a token
   */
  async validateToken(token: string): Promise<AuthResponse> {
    try {
      const response = await fetch(`${this.baseUrl}/auth/validate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        }
      });

      const data = await response.json() as AuthResponse;
      
      if (!data.success) {
        return {
          success: false,
          error: data.error || {
            code: 'INVALID_TOKEN',
            message: 'Invalid token'
          }
        };
      }

      return {
        success: true,
        user: data.user || {
          id: 'temp-user-id',
          role: 'user',
          email: 'user@example.com'
        }
      };
    } catch (error) {
      console.error('Auth validation error:', error);
      return {
        success: false,
        error: {
          code: 'AUTH_ERROR',
          message: 'Failed to validate token'
        }
      };
    }
  }
}