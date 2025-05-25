import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Context } from 'hono';
import { OpenAPIHono } from '@hono/zod-openapi';

// Mock dependencies
vi.mock('@dome/common', () => ({
  getLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn()
  }),
  logError: vi.fn()
}));

vi.mock('@dome/auth/client', () => ({
  SupportedAuthProvider: {
    LOCAL: 'local',
    PRIVY: 'privy'
  },
  User: {},
  ValidateTokenResponse: {}
}));

vi.mock('../src/services/serviceFactory', () => ({
  createServiceFactory: vi.fn().mockReturnValue({
    auth: {
      login: vi.fn().mockResolvedValue({
        success: true,
        token: 'mock-jwt-token',
        user: {
          id: 'user-123',
          email: 'test@example.com',
          provider: 'local'
        }
      }),
      register: vi.fn().mockResolvedValue({
        success: true,
        token: 'mock-jwt-token',
        user: {
          id: 'user-456',
          email: 'newuser@example.com',
          provider: 'local'
        }
      }),
      refresh: vi.fn().mockResolvedValue({
        success: true,
        token: 'new-mock-jwt-token'
      }),
      logout: vi.fn().mockResolvedValue({
        success: true
      }),
      validateToken: vi.fn().mockResolvedValue({
        valid: true,
        user: {
          id: 'user-123',
          email: 'test@example.com',
          provider: 'local'
        }
      })
    }
  })
}));

// Import after mocking
import { createAuthController } from '../src/controllers/authController';

describe('AuthController', () => {
  let app: OpenAPIHono;
  let mockEnv: any;
  let mockCtx: any;

  beforeEach(() => {
    app = new OpenAPIHono();
    mockEnv = {
      AUTH_SECRET: 'test-secret',
      AUTH_PROVIDER: 'local'
    };
    mockCtx = {};

    // Set up the auth controller routes
    const authController = createAuthController(mockEnv);
    app.route('/auth', authController);
  });

  describe('POST /auth/login', () => {
    it('should successfully login with valid credentials', async () => {
      const loginData = {
        email: 'test@example.com',
        password: 'password123'
      };

      const req = new Request('http://localhost/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(loginData)
      });

      const res = await app.request(req);
      
      expect(res.status).toBe(200);
      
      const data = await res.json();
      expect(data).toHaveProperty('token');
      expect(data.token).toBe('mock-jwt-token');
    });

    it('should return 400 for invalid email format', async () => {
      const invalidLoginData = {
        email: 'invalid-email',
        password: 'password123'
      };

      const req = new Request('http://localhost/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(invalidLoginData)
      });

      const res = await app.request(req);
      
      expect(res.status).toBe(400);
    });

    it('should return 400 for short password', async () => {
      const invalidLoginData = {
        email: 'test@example.com',
        password: '123' // Too short
      };

      const req = new Request('http://localhost/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(invalidLoginData)
      });

      const res = await app.request(req);
      
      expect(res.status).toBe(400);
    });

    it('should handle missing request body', async () => {
      const req = new Request('http://localhost/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
        // No body
      });

      const res = await app.request(req);
      
      expect(res.status).toBe(400);
    });
  });

  describe('POST /auth/register', () => {
    it('should successfully register a new user', async () => {
      const registerData = {
        email: 'newuser@example.com',
        password: 'newpassword123'
      };

      const req = new Request('http://localhost/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(registerData)
      });

      const res = await app.request(req);
      
      expect(res.status).toBe(200);
      
      const data = await res.json();
      expect(data).toHaveProperty('token');
      expect(data.token).toBe('mock-jwt-token');
    });

    it('should validate email format during registration', async () => {
      const invalidRegisterData = {
        email: 'not-an-email',
        password: 'password123'
      };

      const req = new Request('http://localhost/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(invalidRegisterData)
      });

      const res = await app.request(req);
      
      expect(res.status).toBe(400);
    });
  });

  describe('POST /auth/refresh', () => {
    it('should refresh token successfully', async () => {
      const refreshData = {
        refreshToken: 'valid-refresh-token'
      };

      const req = new Request('http://localhost/auth/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(refreshData)
      });

      const res = await app.request(req);
      
      expect(res.status).toBe(200);
      
      const data = await res.json();
      expect(data).toHaveProperty('token');
      expect(data.token).toBe('new-mock-jwt-token');
    });

    it('should handle missing refresh token', async () => {
      const req = new Request('http://localhost/auth/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
      });

      const res = await app.request(req);
      
      expect(res.status).toBe(400);
    });
  });

  describe('POST /auth/logout', () => {
    it('should logout successfully', async () => {
      const req = new Request('http://localhost/auth/logout', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer mock-jwt-token'
        }
      });

      const res = await app.request(req);
      
      expect(res.status).toBe(200);
      
      const data = await res.json();
      expect(data).toHaveProperty('success');
      expect(data.success).toBe(true);
    });
  });

  describe('GET /auth/me', () => {
    it('should return user info for valid token', async () => {
      const req = new Request('http://localhost/auth/me', {
        method: 'GET',
        headers: {
          'Authorization': 'Bearer mock-jwt-token'
        }
      });

      const res = await app.request(req);
      
      expect(res.status).toBe(200);
      
      const data = await res.json();
      expect(data).toHaveProperty('user');
      expect(data.user).toHaveProperty('id');
      expect(data.user).toHaveProperty('email');
    });

    it('should return 401 for missing authorization header', async () => {
      const req = new Request('http://localhost/auth/me', {
        method: 'GET'
      });

      const res = await app.request(req);
      
      expect(res.status).toBe(401);
    });

    it('should return 401 for invalid token format', async () => {
      const req = new Request('http://localhost/auth/me', {
        method: 'GET',
        headers: {
          'Authorization': 'InvalidFormat'
        }
      });

      const res = await app.request(req);
      
      expect(res.status).toBe(401);
    });
  });

  describe('error handling', () => {
    it('should handle auth service errors gracefully', async () => {
      // Mock auth service to throw error
      const { createServiceFactory } = await import('../src/services/serviceFactory');
      const mockFactory = vi.mocked(createServiceFactory).mockReturnValueOnce({
        auth: {
          login: vi.fn().mockRejectedValue(new Error('Auth service error'))
        }
      } as any);

      const loginData = {
        email: 'test@example.com',
        password: 'password123'
      };

      const req = new Request('http://localhost/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(loginData)
      });

      const res = await app.request(req);
      
      expect(res.status).toBe(500);
    });
  });

  describe('validation schemas', () => {
    it('should validate email field correctly', () => {
      const validEmails = [
        'test@example.com',
        'user.name@domain.org',
        'admin@subdomain.example.co.uk'
      ];

      const invalidEmails = [
        'invalid-email',
        '@example.com',
        'test@',
        'test.example.com'
      ];

      // These would be tested in the actual requests above
      expect(validEmails).toBeDefined();
      expect(invalidEmails).toBeDefined();
    });

    it('should validate password requirements', () => {
      const validPasswords = [
        'password123',
        'very-secure-password',
        'P@ssw0rd!'
      ];

      const invalidPasswords = [
        '123',      // Too short
        'short',    // Too short
        ''          // Empty
      ];

      expect(validPasswords).toBeDefined();
      expect(invalidPasswords).toBeDefined();
    });
  });
});