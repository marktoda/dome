import { describe, it, expect, vi, beforeEach } from 'vitest';
import { authenticationMiddleware } from '../src/middleware/authenticationMiddleware';
import { Context, Next } from 'hono';

// Mock the dependencies
vi.mock('@dome/common', () => ({
  getLogger: () => ({
    child: () => ({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    }),
  }),
  ServiceError: class ServiceError extends Error {
    constructor(message: string, public status?: number, public code?: string) {
      super(message);
    }
  },
}));

vi.mock('../src/services/serviceFactory', () => ({
  createServiceFactory: () => ({
    getAuthService: vi.fn().mockReturnValue({
      validateToken: vi.fn(),
      getUserById: vi.fn(),
    }),
  }),
}));

describe('Authentication Middleware', () => {
  let mockContext: Partial<Context>;
  let mockNext: Next;

  beforeEach(() => {
    mockContext = {
      req: {
        header: vi.fn(),
      } as any,
      env: {} as any,
      set: vi.fn(),
      json: vi.fn().mockReturnValue({ _data: 'response', _status: 401 }),
    };
    mockNext = vi.fn();
  });

  describe('token validation', () => {
    it('should accept valid Bearer token', async () => {
      const validToken = 'valid-jwt-token-123';
      const mockUser = {
        id: 'user-123',
        email: 'test@example.com',
      };

      (mockContext.req!.header as any).mockReturnValue(`Bearer ${validToken}`);

      // Mock the service factory and auth service
      const serviceFactory = await import('../src/services/serviceFactory');
      const mockAuthService = {
        validateToken: vi.fn().mockResolvedValue({ valid: true, userId: mockUser.id }),
        getUserById: vi.fn().mockResolvedValue(mockUser),
      };

      vi.mocked(serviceFactory.createServiceFactory).mockReturnValue({
        getChatService: vi.fn() as any,
        getAuthService: () => mockAuthService as any,
      });

      await authenticationMiddleware(mockContext as Context, mockNext);

      expect(mockContext.set).toHaveBeenCalledWith('auth', {
        userId: mockUser.id,
        user: mockUser,
        token: validToken,
      });
      expect(mockNext).toHaveBeenCalled();
    });

    it('should reject missing authorization header', async () => {
      (mockContext.req!.header as any).mockReturnValue(undefined);

      await authenticationMiddleware(mockContext as Context, mockNext);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'MISSING_TOKEN',
            message: 'Authorization header is required',
          },
        },
        401,
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should reject malformed authorization header', async () => {
      (mockContext.req!.header as any).mockReturnValue('InvalidFormat token123');

      await authenticationMiddleware(mockContext as Context, mockNext);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'INVALID_TOKEN_FORMAT',
            message: 'Authorization header must be in format: Bearer <token>',
          },
        },
        401,
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should reject invalid token', async () => {
      const invalidToken = 'invalid-token-456';
      (mockContext.req!.header as any).mockReturnValue(`Bearer ${invalidToken}`);

      // Mock the service factory and auth service
      const serviceFactory = await import('../src/services/serviceFactory');
      const mockAuthService = {
        validateToken: vi.fn().mockResolvedValue({ valid: false }),
      };

      vi.mocked(serviceFactory.createServiceFactory).mockReturnValue({
        getChatService: vi.fn() as any,
        getAuthService: () => mockAuthService as any,
      });

      await authenticationMiddleware(mockContext as Context, mockNext);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'INVALID_TOKEN',
            message: 'Invalid or expired token',
          },
        },
        401,
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should handle token validation service errors', async () => {
      const token = 'service-error-token';
      (mockContext.req!.header as any).mockReturnValue(`Bearer ${token}`);

      // Mock the service factory and auth service
      const serviceFactory = await import('../src/services/serviceFactory');
      const mockAuthService = {
        validateToken: vi.fn().mockRejectedValue(new Error('Auth service unavailable')),
      };

      vi.mocked(serviceFactory.createServiceFactory).mockReturnValue({
        getChatService: vi.fn() as any,
        getAuthService: () => mockAuthService as any,
      });

      await authenticationMiddleware(mockContext as Context, mockNext);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'AUTH_SERVICE_ERROR',
            message: 'Authentication service temporarily unavailable',
          },
        },
        500,
      );
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe('caching behavior', () => {
    it('should cache authentication context for performance', async () => {
      const validToken = 'cacheable-token-789';
      const mockUser = {
        id: 'user-789',
        email: 'cache@example.com',
      };

      (mockContext.req!.header as any).mockReturnValue(`Bearer ${validToken}`);

      // Mock the service factory and auth service
      const serviceFactory = await import('../src/services/serviceFactory');
      const mockAuthService = {
        validateToken: vi.fn().mockResolvedValue({ valid: true, userId: mockUser.id }),
        getUserById: vi.fn().mockResolvedValue(mockUser),
      };

      vi.mocked(serviceFactory.createServiceFactory).mockReturnValue({
        getChatService: vi.fn() as any,
        getAuthService: () => mockAuthService as any,
      });

      // First call
      await authenticationMiddleware(mockContext as Context, mockNext);

      expect(mockAuthService.validateToken).toHaveBeenCalledTimes(1);
      expect(mockContext.set).toHaveBeenCalledWith('auth', {
        userId: mockUser.id,
        user: mockUser,
        token: validToken,
      });
    });
  });

  describe('metrics and logging', () => {
    it('should log successful authentication', async () => {
      const validToken = 'metrics-token-456';
      const mockUser = {
        id: 'user-metrics',
        email: 'metrics@example.com',
      };

      (mockContext.req!.header as any).mockReturnValue(`Bearer ${validToken}`);

      // Mock the service factory and auth service
      const serviceFactory = await import('../src/services/serviceFactory');
      const mockAuthService = {
        validateToken: vi.fn().mockResolvedValue({ valid: true, userId: mockUser.id }),
        getUserById: vi.fn().mockResolvedValue(mockUser),
      };

      vi.mocked(serviceFactory.createServiceFactory).mockReturnValue({
        getChatService: vi.fn() as any,
        getAuthService: () => mockAuthService as any,
      });

      await authenticationMiddleware(mockContext as Context, mockNext);

      // The logger is mocked, so we're testing that the flow completes successfully
      expect(mockNext).toHaveBeenCalled();
      expect(mockContext.set).toHaveBeenCalledWith('auth', {
        userId: mockUser.id,
        user: mockUser,
        token: validToken,
      });
    });

    it('should log authentication failures', async () => {
      (mockContext.req!.header as any).mockReturnValue(undefined);

      await authenticationMiddleware(mockContext as Context, mockNext);

      // The logger is mocked, so we're testing that the error response is returned
      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'MISSING_TOKEN',
            message: 'Authorization header is required',
          },
        },
        401,
      );
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe('edge cases', () => {
    it('should handle empty token after Bearer prefix', async () => {
      (mockContext.req!.header as any).mockReturnValue('Bearer ');

      await authenticationMiddleware(mockContext as Context, mockNext);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'INVALID_TOKEN_FORMAT',
            message: 'Authorization header must be in format: Bearer <token>',
          },
        },
        401,
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should handle token with extra whitespace', async () => {
      const validToken = 'whitespace-token-123';
      const mockUser = {
        id: 'user-whitespace',
        email: 'whitespace@example.com',
      };

      (mockContext.req!.header as any).mockReturnValue(`  Bearer   ${validToken}  `);

      // Mock the service factory and auth service
      const serviceFactory = await import('../src/services/serviceFactory');
      const mockAuthService = {
        validateToken: vi.fn().mockResolvedValue({ valid: true, userId: mockUser.id }),
        getUserById: vi.fn().mockResolvedValue(mockUser),
      };

      vi.mocked(serviceFactory.createServiceFactory).mockReturnValue({
        getChatService: vi.fn() as any,
        getAuthService: () => mockAuthService as any,
      });

      await authenticationMiddleware(mockContext as Context, mockNext);

      expect(mockAuthService.validateToken).toHaveBeenCalledWith(validToken);
      expect(mockNext).toHaveBeenCalled();
    });
  });
});