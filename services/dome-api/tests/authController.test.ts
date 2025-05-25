import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Context } from 'hono';
import { AuthController, createAuthController } from '../src/controllers/authController';
import { SupportedAuthProvider } from '@dome/auth/client';
import type { AppEnv } from '../src/types';

// Mock all external dependencies
vi.mock('@dome/common', () => ({
  getLogger: () => ({
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  }),
  logError: vi.fn(),
}));

vi.mock('../src/services/serviceFactory', () => ({
  createServiceFactory: () => ({
    getAuthService: vi.fn(),
  }),
}));

describe('AuthController', () => {
  let controller: AuthController;
  let mockContext: Context<AppEnv>;
  let mockAuthService: any;
  let mockServiceFactory: any;

  beforeEach(() => {
    vi.clearAllMocks();
    
    controller = createAuthController();
    
    // Mock auth service
    mockAuthService = {
      register: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      validateToken: vi.fn(),
      refreshToken: vi.fn(),
    };

    // Mock service factory
    mockServiceFactory = require('../src/services/serviceFactory').createServiceFactory();
    mockServiceFactory.getAuthService.mockReturnValue(mockAuthService);

    // Mock Hono context
    mockContext = {
      env: {
        AUTH: mockAuthService,
      },
      req: {
        header: vi.fn(),
        valid: vi.fn(),
      },
      json: vi.fn(),
    } as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('register', () => {
    const validRegisterBody = {
      email: 'test@example.com',
      password: 'password123',
      name: 'Test User',
    };

    it('should register user successfully', async () => {
      const mockToken = 'jwt-token-123';
      mockAuthService.register.mockResolvedValue({
        success: true,
        token: mockToken,
        user: { id: 'user-123', email: 'test@example.com' },
      });

      mockContext.json.mockReturnValue({ token: mockToken });

      const result = await controller.register(mockContext, validRegisterBody);

      expect(mockAuthService.register).toHaveBeenCalledWith(
        SupportedAuthProvider.LOCAL,
        validRegisterBody
      );
      expect(mockContext.json).toHaveBeenCalledWith({ token: mockToken }, 201);
    });

    it('should handle registration success without token', async () => {
      mockAuthService.register.mockResolvedValue({
        success: true,
        user: { id: 'user-123', email: 'test@example.com' },
        // No token provided
      });

      mockContext.json.mockReturnValue({
        success: false,
        error: { code: 'INTERNAL_SERVER_ERROR', message: expect.any(String) },
      });

      await controller.register(mockContext, validRegisterBody);

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
      const conflictError = {
        error: {
          type: 'user_exists',
          message: 'User with this email already exists',
        },
      };
      mockAuthService.register.mockRejectedValue(conflictError);

      mockContext.json.mockReturnValue({
        success: false,
        error: { code: 'CONFLICT', message: expect.any(String) },
      });

      await controller.register(mockContext, validRegisterBody);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'CONFLICT',
            message: 'User with this email already exists',
          },
        },
        409
      );
    });

    it('should handle validation errors', async () => {
      const validationError = {
        status: 400,
        message: 'Invalid email format',
      };
      mockAuthService.register.mockRejectedValue(validationError);

      mockContext.json.mockReturnValue({
        success: false,
        error: { code: 'BAD_REQUEST', message: expect.any(String) },
      });

      await controller.register(mockContext, validRegisterBody);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'BAD_REQUEST',
            message: 'Invalid email format',
          },
        },
        400
      );
    });

    it('should handle unknown errors', async () => {
      const unknownError = new Error('Something went wrong');
      mockAuthService.register.mockRejectedValue(unknownError);

      mockContext.json.mockReturnValue({
        success: false,
        error: { code: 'BAD_REQUEST', message: expect.any(String) },
      });

      await controller.register(mockContext, validRegisterBody);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'BAD_REQUEST',
            message: 'Something went wrong',
          },
        },
        400
      );
    });
  });

  describe('login', () => {
    const validLoginBody = {
      email: 'test@example.com',
      password: 'password123',
    };

    it('should login user successfully', async () => {
      const mockToken = 'jwt-token-123';
      mockAuthService.login.mockResolvedValue({
        success: true,
        token: mockToken,
        user: { id: 'user-123', email: 'test@example.com' },
      });

      mockContext.json.mockReturnValue({ token: mockToken });

      await controller.login(mockContext, validLoginBody);

      expect(mockAuthService.login).toHaveBeenCalledWith(
        SupportedAuthProvider.LOCAL,
        validLoginBody
      );
      expect(mockContext.json).toHaveBeenCalledWith({ token: mockToken }, 200);
    });

    it('should handle login success without token', async () => {
      mockAuthService.login.mockResolvedValue({
        success: true,
        user: { id: 'user-123', email: 'test@example.com' },
        // No token provided
      });

      mockContext.json.mockReturnValue({
        success: false,
        error: { code: 'UNAUTHORIZED', message: expect.any(String) },
      });

      await controller.login(mockContext, validLoginBody);

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

    it('should handle invalid credentials', async () => {
      const authError = new Error('Invalid credentials');
      mockAuthService.login.mockRejectedValue(authError);

      mockContext.json.mockReturnValue({
        success: false,
        error: { code: 'UNAUTHORIZED', message: expect.any(String) },
      });

      await controller.login(mockContext, validLoginBody);

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

    it('should handle service failure', async () => {
      mockAuthService.login.mockRejectedValue(new Error('Service unavailable'));

      await controller.login(mockContext, validLoginBody);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Service unavailable',
          },
        },
        401
      );
    });
  });

  describe('logout', () => {
    it('should logout successfully', async () => {
      mockContext.req.header.mockReturnValue('Bearer valid-token');
      mockAuthService.logout.mockResolvedValue({ success: true });

      mockContext.json.mockReturnValue({ success: true, message: 'Logout successful' });

      await controller.logout(mockContext);

      expect(mockAuthService.logout).toHaveBeenCalledWith(
        SupportedAuthProvider.LOCAL,
        'valid-token'
      );
      expect(mockContext.json).toHaveBeenCalledWith(
        { success: true, message: 'Logout successful' },
        200
      );
    });

    it('should handle missing Authorization header', async () => {
      mockContext.req.header.mockReturnValue(undefined);

      mockContext.json.mockReturnValue({
        success: false,
        error: { code: 'UNAUTHORIZED', message: expect.any(String) },
      });

      await controller.logout(mockContext);

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

    it('should handle invalid Authorization header format', async () => {
      mockContext.req.header.mockReturnValue('InvalidToken');

      await controller.logout(mockContext);

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
      mockContext.req.header.mockReturnValue('Bearer valid-token');
      mockAuthService.logout.mockResolvedValue({
        success: false,
        error: { code: 'INVALID_TOKEN', message: 'Token is invalid' },
      });

      await controller.logout(mockContext);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Token is invalid',
          },
        },
        500
      );
    });

    it('should handle logout service exception', async () => {
      mockContext.req.header.mockReturnValue('Bearer valid-token');
      mockAuthService.logout.mockRejectedValue(new Error('Service error'));

      await controller.logout(mockContext);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Service error',
          },
        },
        500
      );
    });
  });

  describe('validateToken', () => {
    const mockUser = {
      id: 'user-123',
      email: 'test@example.com',
      name: 'Test User',
      role: 'user',
      emailVerified: true,
      isActive: true,
      createdAt: new Date('2023-01-01T00:00:00.000Z'),
      updatedAt: new Date('2023-01-02T00:00:00.000Z'),
      lastLoginAt: new Date('2023-01-03T00:00:00.000Z'),
      authProvider: SupportedAuthProvider.LOCAL,
      providerAccountId: 'test@example.com',
    };

    it('should validate token successfully', async () => {
      mockContext.req.header.mockReturnValue('Bearer valid-token');
      mockAuthService.validateToken.mockResolvedValue({
        success: true,
        user: mockUser,
        provider: SupportedAuthProvider.LOCAL,
      });

      const expectedUserResponse = {
        id: 'user-123',
        email: 'test@example.com',
        name: 'Test User',
        role: 'user',
        emailVerified: true,
        isActive: true,
        createdAt: '2023-01-01T00:00:00.000Z',
        updatedAt: '2023-01-02T00:00:00.000Z',
        lastLoginAt: '2023-01-03T00:00:00.000Z',
        authProvider: SupportedAuthProvider.LOCAL,
        providerAccountId: 'test@example.com',
        provider: SupportedAuthProvider.LOCAL,
      };

      mockContext.json.mockReturnValue({
        success: true,
        user: expectedUserResponse,
      });

      await controller.validateToken(mockContext);

      expect(mockAuthService.validateToken).toHaveBeenCalledWith(
        'valid-token',
        SupportedAuthProvider.LOCAL
      );
      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: true,
          user: expectedUserResponse,
        },
        200
      );
    });

    it('should handle missing Authorization header', async () => {
      mockContext.req.header.mockReturnValue(undefined);

      await controller.validateToken(mockContext);

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

    it('should handle invalid token format', async () => {
      mockContext.req.header.mockReturnValue('InvalidFormat');

      await controller.validateToken(mockContext);

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
      mockContext.req.header.mockReturnValue('Bearer invalid-token');
      mockAuthService.validateToken.mockResolvedValue({
        success: false,
        error: { message: 'Token expired' },
      });

      await controller.validateToken(mockContext);

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

    it('should handle missing user in response', async () => {
      mockContext.req.header.mockReturnValue('Bearer valid-token');
      mockAuthService.validateToken.mockResolvedValue({
        success: true,
        provider: SupportedAuthProvider.LOCAL,
        // Missing user
      });

      await controller.validateToken(mockContext);

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

    it('should handle user with null lastLoginAt', async () => {
      const userWithNullLogin = { ...mockUser, lastLoginAt: null };
      mockContext.req.header.mockReturnValue('Bearer valid-token');
      mockAuthService.validateToken.mockResolvedValue({
        success: true,
        user: userWithNullLogin,
        provider: SupportedAuthProvider.LOCAL,
      });

      const expectedUserResponse = {
        id: 'user-123',
        email: 'test@example.com',
        name: 'Test User',
        role: 'user',
        emailVerified: true,
        isActive: true,
        createdAt: '2023-01-01T00:00:00.000Z',
        updatedAt: '2023-01-02T00:00:00.000Z',
        lastLoginAt: null,
        authProvider: SupportedAuthProvider.LOCAL,
        providerAccountId: 'test@example.com',
        provider: SupportedAuthProvider.LOCAL,
      };

      await controller.validateToken(mockContext);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: true,
          user: expectedUserResponse,
        },
        200
      );
    });

    it('should handle service exception', async () => {
      mockContext.req.header.mockReturnValue('Bearer valid-token');
      mockAuthService.validateToken.mockRejectedValue(new Error('Service error'));

      await controller.validateToken(mockContext);

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
  });

  describe('refreshToken', () => {
    const validRefreshBody = {
      refreshToken: 'valid-refresh-token',
    };

    it('should refresh token successfully', async () => {
      const mockResponse = {
        success: true,
        token: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresAt: 1717171717,
      };
      mockAuthService.refreshToken.mockResolvedValue(mockResponse);

      mockContext.json.mockReturnValue({
        token: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresAt: 1717171717,
      });

      await controller.refreshToken(mockContext, validRefreshBody);

      expect(mockAuthService.refreshToken).toHaveBeenCalledWith('valid-refresh-token');
      expect(mockContext.json).toHaveBeenCalledWith(
        {
          token: 'new-access-token',
          refreshToken: 'new-refresh-token',
          expiresAt: 1717171717,
        },
        200
      );
    });

    it('should handle refresh service failure', async () => {
      mockAuthService.refreshToken.mockResolvedValue({
        success: false,
      });

      await controller.refreshToken(mockContext, validRefreshBody);

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
      mockAuthService.refreshToken.mockRejectedValue(new Error('Invalid refresh token'));

      await controller.refreshToken(mockContext, validRefreshBody);

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

    it('should handle missing token in response', async () => {
      mockAuthService.refreshToken.mockResolvedValue({
        success: true,
        // Missing token fields
      });

      await controller.refreshToken(mockContext, validRefreshBody);

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

    it('should create independent controller instances', () => {
      const controller1 = createAuthController();
      const controller2 = createAuthController();
      expect(controller1).not.toBe(controller2);
    });
  });

  describe('error handling edge cases', () => {
    it('should handle null error messages gracefully', async () => {
      const errorWithNullMessage = { message: null };
      mockAuthService.login.mockRejectedValue(errorWithNullMessage);

      await controller.login(mockContext, {
        email: 'test@example.com',
        password: 'password123',
      });

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Login processing error',
          },
        },
        401
      );
    });

    it('should handle complex nested error structures', async () => {
      const complexError = {
        error: {
          type: 'custom_error',
          message: 'Custom error message',
        },
        status: 422,
      };
      mockAuthService.register.mockRejectedValue(complexError);

      await controller.register(mockContext, {
        email: 'test@example.com',
        password: 'password123',
        name: 'Test User',
      });

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'CUSTOM_ERROR',
            message: 'Custom error message',
          },
        },
        422
      );
    });

    it('should handle service returning undefined', async () => {
      mockAuthService.login.mockResolvedValue(undefined);

      await controller.login(mockContext, {
        email: 'test@example.com',
        password: 'password123',
      });

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
});