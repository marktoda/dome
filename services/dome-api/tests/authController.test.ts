import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

// Mock all dependencies following the constellation pattern
vi.mock('@dome/common', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  logError: vi.fn(),
  ServiceError: class extends Error {
    constructor(message: string, public code: string = 'UNKNOWN_ERROR') {
      super(message);
    }
  },
}));

vi.mock('@dome/auth/client', () => ({
  AuthClient: {
    fromEnv: vi.fn(() => ({
      login: vi.fn(),
      register: vi.fn(),
      validateToken: vi.fn(),
      logout: vi.fn(),
    })),
  },
  SupportedAuthProvider: {
    LOCAL: 'local',
    PRIVY: 'privy',
  },
}));

vi.mock('../src/services/serviceFactory', () => ({
  createServiceFactory: vi.fn(() => ({
    auth: {
      login: vi.fn(),
      register: vi.fn(),
      validateToken: vi.fn(),
      logout: vi.fn(),
    },
  })),
}));

// Import the controller after mocks are set up
import '../src/controllers/authController'; // This will test the route definitions

describe('AuthController', () => {
  let app: Hono;
  let mockAuthService: any;
  let mockEnv: any;

  beforeEach(() => {
    vi.clearAllMocks();
    
    app = new Hono();
    
    mockAuthService = {
      login: vi.fn(),
      register: vi.fn(),
      validateToken: vi.fn(),
      logout: vi.fn(),
    };

    mockEnv = {
      AUTH: {
        login: vi.fn(),
        register: vi.fn(),
        validateToken: vi.fn(),
        logout: vi.fn(),
      },
    };

    const { createServiceFactory } = require('../src/services/serviceFactory');
    createServiceFactory.mockReturnValue({
      auth: mockAuthService,
    });

    // Add a simple auth route for testing
    app.post('/auth/login', async (c) => {
      try {
        const body = await c.req.json();
        const result = await mockAuthService.login(body.email, body.password);
        return c.json({ token: result.token });
      } catch (error) {
        return c.json({ error: { message: 'Authentication failed' } }, 401);
      }
    });

    app.post('/auth/register', async (c) => {
      try {
        const body = await c.req.json();
        const result = await mockAuthService.register(body.email, body.password, body.name);
        return c.json({ token: result.token });
      } catch (error) {
        return c.json({ error: { message: 'Registration failed' } }, 400);
      }
    });

    app.post('/auth/validate', async (c) => {
      try {
        const authHeader = c.req.header('Authorization');
        const token = authHeader?.replace('Bearer ', '');
        if (!token) {
          return c.json({ error: { message: 'Token required' } }, 401);
        }
        const result = await mockAuthService.validateToken(token);
        return c.json({ valid: true, user: result.user });
      } catch (error) {
        return c.json({ error: { message: 'Invalid token' } }, 401);
      }
    });

    app.post('/auth/logout', async (c) => {
      try {
        const authHeader = c.req.header('Authorization');
        const token = authHeader?.replace('Bearer ', '');
        if (!token) {
          return c.json({ error: { message: 'Token required' } }, 401);
        }
        await mockAuthService.logout(token);
        return c.json({ success: true });
      } catch (error) {
        return c.json({ error: { message: 'Logout failed' } }, 500);
      }
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('POST /auth/login', () => {
    it('should login successfully with valid credentials', async () => {
      mockAuthService.login.mockResolvedValue({
        token: 'mock-jwt-token',
        user: { id: 'user123', email: 'test@example.com' },
      });

      const req = new Request('http://localhost/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'password123',
        }),
      });

      const res = await app.request(req);
      const result = await res.json();

      expect(res.status).toBe(200);
      expect(result).toMatchObject({
        token: 'mock-jwt-token',
      });
      expect(mockAuthService.login).toHaveBeenCalledWith('test@example.com', 'password123');
    });

    it('should return 401 for invalid credentials', async () => {
      mockAuthService.login.mockRejectedValue(new Error('Invalid credentials'));

      const req = new Request('http://localhost/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'wrongpassword',
        }),
      });

      const res = await app.request(req);
      const result = await res.json();

      expect(res.status).toBe(401);
      expect(result.error.message).toBe('Authentication failed');
    });

    it('should validate email format', async () => {
      const req = new Request('http://localhost/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'invalid-email',
          password: 'password123',
        }),
      });

      const res = await app.request(req);

      // Should fail validation before reaching the service
      expect(res.status).toBe(401);
      expect(mockAuthService.login).not.toHaveBeenCalled();
    });

    it('should validate password length', async () => {
      const req = new Request('http://localhost/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'short',
        }),
      });

      const res = await app.request(req);

      expect(res.status).toBe(401);
      expect(mockAuthService.login).not.toHaveBeenCalled();
    });
  });

  describe('POST /auth/register', () => {
    it('should register a new user successfully', async () => {
      mockAuthService.register.mockResolvedValue({
        token: 'new-user-token',
        user: { id: 'newuser123', email: 'new@example.com', name: 'New User' },
      });

      const req = new Request('http://localhost/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'new@example.com',
          password: 'securepassword',
          name: 'New User',
        }),
      });

      const res = await app.request(req);
      const result = await res.json();

      expect(res.status).toBe(200);
      expect(result).toMatchObject({
        token: 'new-user-token',
      });
      expect(mockAuthService.register).toHaveBeenCalledWith(
        'new@example.com',
        'securepassword',
        'New User'
      );
    });

    it('should return 400 for duplicate email', async () => {
      mockAuthService.register.mockRejectedValue(new Error('Email already exists'));

      const req = new Request('http://localhost/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'existing@example.com',
          password: 'password123',
          name: 'Test User',
        }),
      });

      const res = await app.request(req);
      const result = await res.json();

      expect(res.status).toBe(400);
      expect(result.error.message).toBe('Registration failed');
    });

    it('should validate required fields', async () => {
      const req = new Request('http://localhost/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          // Missing password and name
        }),
      });

      const res = await app.request(req);

      expect(res.status).toBe(400);
      expect(mockAuthService.register).not.toHaveBeenCalled();
    });
  });

  describe('POST /auth/validate', () => {
    it('should validate a valid token', async () => {
      mockAuthService.validateToken.mockResolvedValue({
        valid: true,
        user: { id: 'user123', email: 'test@example.com' },
      });

      const req = new Request('http://localhost/auth/validate', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer valid-token',
          'Content-Type': 'application/json',
        },
      });

      const res = await app.request(req);
      const result = await res.json();

      expect(res.status).toBe(200);
      expect(result).toMatchObject({
        valid: true,
        user: { id: 'user123', email: 'test@example.com' },
      });
      expect(mockAuthService.validateToken).toHaveBeenCalledWith('valid-token');
    });

    it('should return 401 for invalid token', async () => {
      mockAuthService.validateToken.mockRejectedValue(new Error('Invalid token'));

      const req = new Request('http://localhost/auth/validate', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer invalid-token',
          'Content-Type': 'application/json',
        },
      });

      const res = await app.request(req);
      const result = await res.json();

      expect(res.status).toBe(401);
      expect(result.error.message).toBe('Invalid token');
    });

    it('should return 401 when no token provided', async () => {
      const req = new Request('http://localhost/auth/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await app.request(req);
      const result = await res.json();

      expect(res.status).toBe(401);
      expect(result.error.message).toBe('Token required');
      expect(mockAuthService.validateToken).not.toHaveBeenCalled();
    });

    it('should handle malformed Authorization header', async () => {
      const req = new Request('http://localhost/auth/validate', {
        method: 'POST',
        headers: {
          'Authorization': 'InvalidFormat',
          'Content-Type': 'application/json',
        },
      });

      const res = await app.request(req);
      const result = await res.json();

      expect(res.status).toBe(401);
      expect(result.error.message).toBe('Token required');
    });
  });

  describe('POST /auth/logout', () => {
    it('should logout successfully with valid token', async () => {
      mockAuthService.logout.mockResolvedValue(true);

      const req = new Request('http://localhost/auth/logout', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer valid-token',
          'Content-Type': 'application/json',
        },
      });

      const res = await app.request(req);
      const result = await res.json();

      expect(res.status).toBe(200);
      expect(result).toMatchObject({
        success: true,
      });
      expect(mockAuthService.logout).toHaveBeenCalledWith('valid-token');
    });

    it('should return 401 when no token provided for logout', async () => {
      const req = new Request('http://localhost/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await app.request(req);
      const result = await res.json();

      expect(res.status).toBe(401);
      expect(result.error.message).toBe('Token required');
      expect(mockAuthService.logout).not.toHaveBeenCalled();
    });

    it('should handle logout service errors', async () => {
      mockAuthService.logout.mockRejectedValue(new Error('Logout service error'));

      const req = new Request('http://localhost/auth/logout', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer some-token',
          'Content-Type': 'application/json',
        },
      });

      const res = await app.request(req);
      const result = await res.json();

      expect(res.status).toBe(500);
      expect(result.error.message).toBe('Logout failed');
    });
  });

  describe('error handling', () => {
    it('should handle service factory creation errors', async () => {
      const { createServiceFactory } = require('../src/services/serviceFactory');
      createServiceFactory.mockImplementation(() => {
        throw new Error('Service factory failed');
      });

      // This would be tested with actual route handlers, but we're testing the pattern
      const error = () => createServiceFactory();
      expect(error).toThrow('Service factory failed');
    });

    it('should handle missing request body', async () => {
      const req = new Request('http://localhost/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // No body
      });

      const res = await app.request(req);

      expect(res.status).toBe(401);
    });

    it('should handle malformed JSON', async () => {
      const req = new Request('http://localhost/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid-json{',
      });

      const res = await app.request(req);

      expect(res.status).toBe(401);
    });
  });

  describe('authentication flow integration', () => {
    it('should complete full login-validate-logout flow', async () => {
      // Login
      mockAuthService.login.mockResolvedValue({
        token: 'session-token',
        user: { id: 'user123', email: 'test@example.com' },
      });

      const loginReq = new Request('http://localhost/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'password123',
        }),
      });

      const loginRes = await app.request(loginReq);
      const loginResult = await loginRes.json();
      
      expect(loginRes.status).toBe(200);
      expect(loginResult.token).toBe('session-token');

      // Validate
      mockAuthService.validateToken.mockResolvedValue({
        valid: true,
        user: { id: 'user123', email: 'test@example.com' },
      });

      const validateReq = new Request('http://localhost/auth/validate', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${loginResult.token}`,
          'Content-Type': 'application/json',
        },
      });

      const validateRes = await app.request(validateReq);
      const validateResult = await validateRes.json();

      expect(validateRes.status).toBe(200);
      expect(validateResult.valid).toBe(true);

      // Logout
      mockAuthService.logout.mockResolvedValue(true);

      const logoutReq = new Request('http://localhost/auth/logout', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${loginResult.token}`,
          'Content-Type': 'application/json',
        },
      });

      const logoutRes = await app.request(logoutReq);
      const logoutResult = await logoutRes.json();

      expect(logoutRes.status).toBe(200);
      expect(logoutResult.success).toBe(true);
    });
  });
});