import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Mock dependencies
vi.mock('@dome/common', () => ({
  getLogger: vi.fn().mockReturnValue({
    child: vi.fn().mockReturnValue({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    }),
  }),
  createServiceMetrics: vi.fn().mockReturnValue({
    incrementCounter: vi.fn(),
    recordHistogram: vi.fn(),
  }),
}));

vi.mock('../src/middleware/authenticationMiddleware', () => ({
  authenticationMiddleware: vi.fn().mockImplementation(() => async (c, next) => {
    c.set('user', { id: 'test-user', email: 'test@example.com' });
    await next();
  }),
}));

// Import after mocking
import { createAuthController } from '../src/controllers/authController';

describe('AuthController', () => {
  let app: Hono;
  let mockEnv: any;

  beforeEach(() => {
    mockEnv = {
      AUTH: {
        authenticate: vi.fn().mockResolvedValue({
          success: true,
          user: { id: 'test-user', email: 'test@example.com' },
          accessToken: 'test-token',
        }),
        register: vi.fn().mockResolvedValue({
          success: true,
          user: { id: 'new-user', email: 'new@example.com' },
          accessToken: 'new-token',
        }),
        logout: vi.fn().mockResolvedValue({ success: true }),
      },
    };

    app = new Hono();
    const authController = createAuthController(mockEnv);
    app.route('/auth', authController);
    vi.clearAllMocks();
  });

  describe('POST /auth/login', () => {
    it('should authenticate user successfully', async () => {
      const loginRequest = {
        email: 'test@example.com',
        password: 'password123',
        provider: 'local',
      };

      const response = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(loginRequest),
      });

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.success).toBe(true);
      expect(result.user).toMatchObject({
        id: 'test-user',
        email: 'test@example.com',
      });
      expect(result.accessToken).toBe('test-token');
    });

    it('should handle missing credentials', async () => {
      const invalidRequest = {
        email: 'test@example.com',
        // Missing password
      };

      const response = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invalidRequest),
      });

      expect(response.status).toBe(400);
    });

    it('should handle invalid email format', async () => {
      const invalidEmailRequest = {
        email: 'invalid-email',
        password: 'password123',
        provider: 'local',
      };

      const response = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invalidEmailRequest),
      });

      expect(response.status).toBe(400);
    });

    it('should handle authentication failures', async () => {
      mockEnv.AUTH.authenticate.mockResolvedValueOnce({
        success: false,
        error: 'Invalid credentials',
      });

      const loginRequest = {
        email: 'wrong@example.com',
        password: 'wrongpassword',
        provider: 'local',
      };

      const response = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(loginRequest),
      });

      expect(response.status).toBe(401);
    });
  });

  describe('POST /auth/register', () => {
    it('should register new user successfully', async () => {
      const registerRequest = {
        email: 'new@example.com',
        password: 'password123',
        provider: 'local',
      };

      const response = await app.request('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(registerRequest),
      });

      expect(response.status).toBe(201);
      const result = await response.json();
      expect(result.success).toBe(true);
      expect(result.user).toMatchObject({
        id: 'new-user',
        email: 'new@example.com',
      });
    });

    it('should handle duplicate email registration', async () => {
      mockEnv.AUTH.register.mockResolvedValueOnce({
        success: false,
        error: 'Email already exists',
      });

      const registerRequest = {
        email: 'existing@example.com',
        password: 'password123',
        provider: 'local',
      };

      const response = await app.request('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(registerRequest),
      });

      expect(response.status).toBe(409);
    });

    it('should validate password strength', async () => {
      const weakPasswordRequest = {
        email: 'test@example.com',
        password: '123', // Too weak
        provider: 'local',
      };

      const response = await app.request('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(weakPasswordRequest),
      });

      expect(response.status).toBe(400);
    });
  });

  describe('POST /auth/logout', () => {
    it('should logout user successfully', async () => {
      const response = await app.request('/auth/logout', {
        method: 'POST',
        headers: { 
          'Authorization': 'Bearer test-token',
          'Content-Type': 'application/json',
        },
      });

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.success).toBe(true);
    });

    it('should handle logout without token', async () => {
      const response = await app.request('/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      expect(response.status).toBe(401);
    });
  });

  describe('GET /auth/me', () => {
    it('should return current user info', async () => {
      const response = await app.request('/auth/me', {
        headers: { 
          'Authorization': 'Bearer test-token',
        },
      });

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.user).toMatchObject({
        id: 'test-user',
        email: 'test@example.com',
      });
    });

    it('should handle missing authorization', async () => {
      const response = await app.request('/auth/me');

      expect(response.status).toBe(401);
    });
  });

  describe('error handling', () => {
    it('should handle service errors gracefully', async () => {
      mockEnv.AUTH.authenticate.mockRejectedValueOnce(new Error('Service error'));

      const loginRequest = {
        email: 'test@example.com',
        password: 'password123',
        provider: 'local',
      };

      const response = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(loginRequest),
      });

      expect(response.status).toBe(500);
    });
  });
});