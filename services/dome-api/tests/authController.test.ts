import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Context } from 'hono';
import { z } from 'zod';

// Mock common dependencies
vi.mock('@dome/common', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
  logError: vi.fn(),
  ServiceError: class extends Error {
    code: string;
    status?: number;
    constructor(message: string, code: string, status?: number) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
}));

// Mock auth service types
vi.mock('@dome/auth/client', () => ({
  SupportedAuthProvider: {
    LOCAL: 'LOCAL',
    PRIVY: 'PRIVY',
  },
}));

// Mock service factory
const mockAuthService = {
  register: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  validateToken: vi.fn(),
  refreshToken: vi.fn(),
};

vi.mock('../src/services/serviceFactory', () => ({
  createServiceFactory: () => ({
    getAuthService: () => mockAuthService,
  }),
}));

import { AuthController, createAuthController } from '../src/controllers/authController';
import type { AppEnv } from '../src/types';

describe('AuthController', () => {
  let authController: AuthController;
  let mockContext: Context<AppEnv>;

  beforeEach(() => {
    vi.clearAllMocks();
    authController = createAuthController();
    
    // Create a mock Hono context
    mockContext = {
      env: {
        AUTH_SERVICE: {},
        CONSTELLATION_SERVICE: {},
        SILO_SERVICE: {},
      },
      req: {
        header: vi.fn(),
        valid: vi.fn(),
      },
      json: vi.fn((data, status) => ({
        data,
        status,
        headers: new Headers(),
      })),
      get: vi.fn(),
      set: vi.fn(),
    } as any;
  });

  describe('register', () => {
    const validRegisterBody = {
      email: 'test@example.com',
      password: 'password123',
      name: 'Test User',
    };

    it('should successfully register a new user', async () => {
      const mockResponse = {
        success: true,
        token: 'jwt-token-123',
        user: { id: '1', email: 'test@example.com' },
      };
      mockAuthService.register.mockResolvedValue(mockResponse);

      const result = await authController.register(mockContext, validRegisterBody);

      expect(mockAuthService.register).toHaveBeenCalledWith('LOCAL', validRegisterBody);
      expect(mockContext.json).toHaveBeenCalledWith(
        { token: 'jwt-token-123' },
        201
      );
    });

    it('should handle registration success but missing token', async () => {
      const mockResponse = {
        success: true,
        token: undefined,
      };
      mockAuthService.register.mockResolvedValue(mockResponse);

      const result = await authController.register(mockContext, validRegisterBody);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Registration successful, but failed to issue token.',
          },
        },
        500
      );
    });

    it('should handle user already exists error', async () => {
      const mockError = {
        error: {
          type: 'user_exists',
          message: 'User already exists',
        },
      };
      mockAuthService.register.mockRejectedValue(mockError);

      const result = await authController.register(mockContext, validRegisterBody);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'CONFLICT',
            message: 'User already exists',
          },
        },
        409
      );
    });

    it('should handle validation errors', async () => {
      const mockError = {
        error: {
          type: 'validation_error',
          message: 'Invalid email format',
        },
        status: 400,
      };
      mockAuthService.register.mockRejectedValue(mockError);

      const result = await authController.register(mockContext, validRegisterBody);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid email format',
          },
        },
        400
      );
    });

    it('should handle generic errors', async () => {
      const mockError = new Error('Network error');
      mockAuthService.register.mockRejectedValue(mockError);

      const result = await authController.register(mockContext, validRegisterBody);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'BAD_REQUEST',
            message: 'Network error',
          },
        },
        400
      );
    });

    it('should handle errors without message property', async () => {
      const mockError = { status: 500 };
      mockAuthService.register.mockRejectedValue(mockError);

      const result = await authController.register(mockContext, validRegisterBody);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'BAD_REQUEST',
            message: 'Registration processing error',
          },
        },
        500
      );
    });
  });

  describe('login', () => {
    const validLoginBody = {
      email: 'test@example.com',
      password: 'password123',
    };

    it('should successfully login a user', async () => {
      const mockResponse = {
        success: true,
        token: 'jwt-token-123',
        user: { id: '1', email: 'test@example.com' },
      };
      mockAuthService.login.mockResolvedValue(mockResponse);

      const result = await authController.login(mockContext, validLoginBody);

      expect(mockAuthService.login).toHaveBeenCalledWith('LOCAL', validLoginBody);
      expect(mockContext.json).toHaveBeenCalledWith(
        { token: 'jwt-token-123' },
        200
      );
    });

    it('should handle login success but missing token', async () => {
      const mockResponse = {
        success: true,
        token: undefined,
      };
      mockAuthService.login.mockResolvedValue(mockResponse);

      const result = await authController.login(mockContext, validLoginBody);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Login successful but failed to issue token.',
          },
        },
        401
      );
    });

    it('should handle invalid credentials error', async () => {
      const mockError = new Error('Invalid credentials');
      mockAuthService.login.mockRejectedValue(mockError);

      const result = await authController.login(mockContext, validLoginBody);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Invalid credentials',
          },
        },
        401
      );
    });

    it('should handle login failure with no message', async () => {
      const mockError = {};
      mockAuthService.login.mockRejectedValue(mockError);

      const result = await authController.login(mockContext, validLoginBody);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'undefined',
          },
        },
        401
      );
    });

    it('should handle success false from service', async () => {
      const mockResponse = {
        success: false,
        token: null,
      };
      mockAuthService.login.mockResolvedValue(mockResponse);

      const result = await authController.login(mockContext, validLoginBody);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Login successful but failed to issue token.',
          },
        },
        401
      );
    });
  });

  describe('logout', () => {
    beforeEach(() => {
      mockContext.req.header = vi.fn().mockReturnValue('Bearer valid-token');
    });

    it('should successfully logout a user', async () => {
      const mockResponse = { success: true };
      mockAuthService.logout.mockResolvedValue(mockResponse);

      const result = await authController.logout(mockContext);

      expect(mockAuthService.logout).toHaveBeenCalledWith('LOCAL', 'valid-token');
      expect(mockContext.json).toHaveBeenCalledWith(
        { success: true, message: 'Logout successful' },
        200
      );
    });

    it('should handle missing authorization header', async () => {
      mockContext.req.header = vi.fn().mockReturnValue(undefined);

      const result = await authController.logout(mockContext);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication token required',
          },
        },
        401
      );
    });

    it('should handle invalid authorization header format', async () => {
      mockContext.req.header = vi.fn().mockReturnValue('InvalidFormat token');

      const result = await authController.logout(mockContext);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication token required',
          },
        },
        401
      );
    });

    it('should handle logout service failure', async () => {
      const mockResponse = {
        success: false,
        error: { code: 'LOGOUT_FAILED', message: 'Token invalidation failed' },
      };
      mockAuthService.logout.mockResolvedValue(mockResponse);

      const result = await authController.logout(mockContext);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Token invalidation failed',
          },
        },
        500
      );
    });

    it('should handle logout service exception', async () => {
      const mockError = new Error('Service unavailable');
      mockAuthService.logout.mockRejectedValue(mockError);

      const result = await authController.logout(mockContext);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Service unavailable',
          },
        },
        500
      );
    });

    it('should handle logout failure without error details', async () => {
      const mockResponse = { success: false };
      mockAuthService.logout.mockResolvedValue(mockResponse);

      const result = await authController.logout(mockContext);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'undefined',
          },
        },
        500
      );
    });
  });

  describe('validateToken', () => {
    beforeEach(() => {
      mockContext.req.header = vi.fn().mockReturnValue('Bearer valid-token');
    });

    it('should successfully validate a token', async () => {
      const mockUser = {
        id: '1',
        email: 'test@example.com',
        name: 'Test User',
        role: 'user' as const,
        emailVerified: true,
        isActive: true,
        createdAt: new Date('2023-01-01'),
        updatedAt: new Date('2023-01-01'),
        lastLoginAt: new Date('2023-01-01'),
        authProvider: 'LOCAL',
        providerAccountId: 'test@example.com',
      };

      const mockResponse = {
        success: true,
        user: mockUser,
        provider: 'LOCAL' as const,
      };
      mockAuthService.validateToken.mockResolvedValue(mockResponse);

      const result = await authController.validateToken(mockContext);

      expect(mockAuthService.validateToken).toHaveBeenCalledWith('valid-token', 'LOCAL');
      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: true,
          user: expect.objectContaining({
            id: '1',
            email: 'test@example.com',
            name: 'Test User',
            role: 'user',
            provider: 'LOCAL',
            createdAt: '2023-01-01T00:00:00.000Z',
            updatedAt: '2023-01-01T00:00:00.000Z',
            lastLoginAt: '2023-01-01T00:00:00.000Z',
          }),
        },
        200
      );
    });

    it('should handle missing authorization header', async () => {
      mockContext.req.header = vi.fn().mockReturnValue(undefined);

      const result = await authController.validateToken(mockContext);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication token required',
          },
        },
        401
      );
    });

    it('should handle validation service failure', async () => {
      const mockResponse = {
        success: false,
        error: { message: 'Token expired' },
      };
      mockAuthService.validateToken.mockResolvedValue(mockResponse);

      const result = await authController.validateToken(mockContext);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Token expired',
          },
        },
        401
      );
    });

    it('should handle validation service exception', async () => {
      const mockError = new Error('Service error');
      mockAuthService.validateToken.mockRejectedValue(mockError);

      const result = await authController.validateToken(mockContext);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Service error',
          },
        },
        401
      );
    });

    it('should handle user with null optional fields', async () => {
      const mockUser = {
        id: '1',
        email: 'test@example.com',
        name: null,
        role: 'admin' as const,
        emailVerified: false,
        isActive: true,
        createdAt: new Date('2023-01-01'),
        updatedAt: new Date('2023-01-02'),
        lastLoginAt: null,
        authProvider: null,
        providerAccountId: null,
      };

      const mockResponse = {
        success: true,
        user: mockUser,
        provider: 'LOCAL' as const,
      };
      mockAuthService.validateToken.mockResolvedValue(mockResponse);

      const result = await authController.validateToken(mockContext);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: true,
          user: expect.objectContaining({
            id: '1',
            email: 'test@example.com',
            name: null,
            role: 'admin',
            emailVerified: false,
            lastLoginAt: null,
            authProvider: null,
            providerAccountId: null,
          }),
        },
        200
      );
    });

    it('should handle validation failure without error message', async () => {
      const mockResponse = { success: false };
      mockAuthService.validateToken.mockResolvedValue(mockResponse);

      const result = await authController.validateToken(mockContext);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Invalid or expired token, or user data missing.',
          },
        },
        401
      );
    });
  });

  describe('refreshToken', () => {
    const validRefreshBody = {
      refreshToken: 'refresh-token-123',
    };

    it('should successfully refresh a token', async () => {
      const mockResponse = {
        success: true,
        token: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresAt: 1234567890,
      };
      mockAuthService.refreshToken.mockResolvedValue(mockResponse);

      const result = await authController.refreshToken(mockContext, validRefreshBody);

      expect(mockAuthService.refreshToken).toHaveBeenCalledWith('refresh-token-123');
      expect(mockContext.json).toHaveBeenCalledWith(
        {
          token: 'new-access-token',
          refreshToken: 'new-refresh-token',
          expiresAt: 1234567890,
        },
        200
      );
    });

    it('should handle refresh service failure', async () => {
      const mockResponse = { success: false };
      mockAuthService.refreshToken.mockResolvedValue(mockResponse);

      const result = await authController.refreshToken(mockContext, validRefreshBody);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Refresh successful but failed to issue token.',
          },
        },
        401
      );
    });

    it('should handle refresh service exception', async () => {
      const mockError = new Error('Invalid refresh token');
      mockAuthService.refreshToken.mockRejectedValue(mockError);

      const result = await authController.refreshToken(mockContext, validRefreshBody);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Invalid refresh token',
          },
        },
        401
      );
    });

    it('should handle refresh without error message', async () => {
      const mockError = {};
      mockAuthService.refreshToken.mockRejectedValue(mockError);

      const result = await authController.refreshToken(mockContext, validRefreshBody);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'undefined',
          },
        },
        401
      );
    });

    it('should handle undefined response from service', async () => {
      mockAuthService.refreshToken.mockResolvedValue(undefined);

      const result = await authController.refreshToken(mockContext, validRefreshBody);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Refresh successful but failed to issue token.',
          },
        },
        401
      );
    });
  });

  describe('createAuthController', () => {
    it('should create a new AuthController instance', () => {
      const controller = createAuthController();
      expect(controller).toBeInstanceOf(AuthController);
    });

    it('should create different instances on multiple calls', () => {
      const controller1 = createAuthController();
      const controller2 = createAuthController();
      expect(controller1).not.toBe(controller2);
    });
  });
});