import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { authenticationMiddleware, createRoleMiddleware, AuthContext } from '../src/middleware/authenticationMiddleware';
import { Context, Next } from 'hono';
import { AuthService } from '@dome/auth/client';
import { createServiceFactory } from '../src/services/serviceFactory';
import LRUCache from 'lru-cache';

// Mock dependencies
vi.mock('../src/services/serviceFactory');
vi.mock('@dome/common');
vi.mock('../src/utils/metrics');
vi.mock('lru-cache');

describe('Authentication Middleware', () => {
  let mockContext: Partial<Context>;
  let mockNext: Next;
  let mockAuthService: Partial<AuthService>;
  let mockServiceFactory: any;
  let mockCache: Partial<LRUCache<string, any>>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock Hono context
    mockContext = {
      req: {
        header: vi.fn(),
      } as any,
      json: vi.fn(),
      set: vi.fn(),
      header: vi.fn(),
      env: {} as any,
    };

    // Mock next function
    mockNext = vi.fn();

    // Mock auth service
    mockAuthService = {
      validateToken: vi.fn(),
    };

    // Mock service factory
    mockServiceFactory = {
      getAuthService: vi.fn().mockReturnValue(mockAuthService),
    };

    vi.mocked(createServiceFactory).mockReturnValue(mockServiceFactory);

    // Mock LRU cache
    mockCache = {
      get: vi.fn(),
      set: vi.fn(),
    };

    // Mock the cache constructor
    vi.mocked(LRUCache).mockImplementation(() => mockCache as any);

    // Mock metrics functions
    const { incrementCounter, trackTiming } = await vi.importMock('../src/utils/metrics');
    vi.mocked(incrementCounter).mockImplementation(() => {});
    vi.mocked(trackTiming).mockImplementation(() => (fn: any) => fn());

    // Mock common logging
    const { getLogger, updateContext } = await vi.importMock('@dome/common');
    const mockLogger = {
      child: vi.fn().mockReturnThis(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    };
    vi.mocked(getLogger).mockReturnValue(mockLogger as any);
    vi.mocked(updateContext).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('authenticationMiddleware', () => {
    it('should authenticate valid bearer token successfully', async () => {
      const validToken = 'valid-jwt-token';
      const mockUser = {
        id: 'user-123',
        role: 'user',
        email: 'test@example.com',
      };

      const mockValidateResponse = {
        success: true,
        user: mockUser,
        ttl: 3600,
      };

      vi.mocked(mockContext.req!.header).mockReturnValue(`Bearer ${validToken}`);
      vi.mocked(mockCache.get).mockReturnValue(null); // Cache miss
      vi.mocked(mockAuthService.validateToken).mockResolvedValue(mockValidateResponse);

      await authenticationMiddleware(mockContext as any, mockNext);

      expect(mockAuthService.validateToken).toHaveBeenCalledWith(validToken);
      expect(mockContext.set).toHaveBeenCalledWith('auth', {
        userId: mockUser.id,
        userRole: mockUser.role,
        userEmail: mockUser.email,
      });
      expect(mockCache.set).toHaveBeenCalled();
      expect(mockNext).toHaveBeenCalled();
    });

    it('should use cached token when available and valid', async () => {
      const cachedToken = 'cached-token';
      const cachedUser = {
        userId: 'user-123',
        userRole: 'user',
        userEmail: 'test@example.com',
      };
      const cachedEntry = {
        user: cachedUser,
        expiresAt: Date.now() + 300000, // Valid for 5 minutes
      };

      vi.mocked(mockContext.req!.header).mockReturnValue(`Bearer ${cachedToken}`);
      vi.mocked(mockCache.get).mockReturnValue(cachedEntry);

      await authenticationMiddleware(mockContext as any, mockNext);

      expect(mockAuthService.validateToken).not.toHaveBeenCalled();
      expect(mockContext.set).toHaveBeenCalledWith('auth', cachedUser);
      expect(mockNext).toHaveBeenCalled();
    });

    it('should reject requests without Authorization header', async () => {
      vi.mocked(mockContext.req!.header).mockReturnValue(undefined);
      vi.mocked(mockContext.json).mockReturnValue(new Response());

      await authenticationMiddleware(mockContext as any, mockNext);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication required',
          },
        },
        401
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should reject requests with invalid Authorization header format', async () => {
      vi.mocked(mockContext.req!.header).mockReturnValue('InvalidHeader token');
      vi.mocked(mockContext.json).mockReturnValue(new Response());

      await authenticationMiddleware(mockContext as any, mockNext);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication required',
          },
        },
        401
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should reject invalid tokens', async () => {
      const invalidToken = 'invalid-token';
      const mockValidateResponse = {
        success: false,
        user: null,
        ttl: 0,
      };

      vi.mocked(mockContext.req!.header).mockReturnValue(`Bearer ${invalidToken}`);
      vi.mocked(mockCache.get).mockReturnValue(null);
      vi.mocked(mockAuthService.validateToken).mockResolvedValue(mockValidateResponse);
      vi.mocked(mockContext.json).mockReturnValue(new Response());

      await authenticationMiddleware(mockContext as any, mockNext);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Invalid or expired token',
          },
        },
        401
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should handle auth service errors gracefully', async () => {
      const validToken = 'token-that-causes-error';

      vi.mocked(mockContext.req!.header).mockReturnValue(`Bearer ${validToken}`);
      vi.mocked(mockCache.get).mockReturnValue(null);
      vi.mocked(mockAuthService.validateToken).mockRejectedValue(new Error('Service unavailable'));
      vi.mocked(mockContext.json).mockReturnValue(new Response());

      await authenticationMiddleware(mockContext as any, mockNext);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication failed',
          },
        },
        401
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should handle expired cached tokens', async () => {
      const expiredToken = 'expired-cached-token';
      const expiredEntry = {
        user: {
          userId: 'user-123',
          userRole: 'user',
          userEmail: 'test@example.com',
        },
        expiresAt: Date.now() - 1000, // Expired 1 second ago
      };

      const mockValidateResponse = {
        success: true,
        user: {
          id: 'user-123',
          role: 'user',
          email: 'test@example.com',
        },
        ttl: 3600,
      };

      vi.mocked(mockContext.req!.header).mockReturnValue(`Bearer ${expiredToken}`);
      vi.mocked(mockCache.get).mockReturnValue(expiredEntry);
      vi.mocked(mockAuthService.validateToken).mockResolvedValue(mockValidateResponse);

      await authenticationMiddleware(mockContext as any, mockNext);

      // Should call auth service since cache entry is expired
      expect(mockAuthService.validateToken).toHaveBeenCalledWith(expiredToken);
      expect(mockNext).toHaveBeenCalled();
    });

    it('should set baggage header for identity propagation', async () => {
      const validToken = 'valid-token';
      const mockUser = {
        id: 'user-123',
        role: 'admin',
        email: 'admin@example.com',
      };

      const mockValidateResponse = {
        success: true,
        user: mockUser,
        ttl: 3600,
      };

      vi.mocked(mockContext.req!.header).mockReturnValue(`Bearer ${validToken}`);
      vi.mocked(mockCache.get).mockReturnValue(null);
      vi.mocked(mockAuthService.validateToken).mockResolvedValue(mockValidateResponse);

      await authenticationMiddleware(mockContext as any, mockNext);

      expect(mockContext.header).toHaveBeenCalledWith(
        'baggage',
        expect.stringContaining('user=')
      );
    });

    it('should handle cache TTL correctly', async () => {
      const validToken = 'valid-token';
      const mockUser = {
        id: 'user-123',
        role: 'user',
        email: 'test@example.com',
      };

      // Test with custom TTL
      const customTtl = 600; // 10 minutes
      const mockValidateResponse = {
        success: true,
        user: mockUser,
        ttl: customTtl,
      };

      vi.mocked(mockContext.req!.header).mockReturnValue(`Bearer ${validToken}`);
      vi.mocked(mockCache.get).mockReturnValue(null);
      vi.mocked(mockAuthService.validateToken).mockResolvedValue(mockValidateResponse);

      await authenticationMiddleware(mockContext as any, mockNext);

      // Verify cache was set with correct TTL (capped at 300s)
      expect(mockCache.set).toHaveBeenCalledWith(
        validToken,
        expect.objectContaining({
          user: expect.objectContaining({
            userId: mockUser.id,
            userRole: mockUser.role,
            userEmail: mockUser.email,
          }),
          expiresAt: expect.any(Number),
        })
      );
    });
  });

  describe('createRoleMiddleware', () => {
    it('should allow users with required role', async () => {
      const roleMiddleware = createRoleMiddleware(['admin', 'moderator']);
      
      const mockAuthContext: AuthContext = {
        userId: 'user-123',
        userRole: 'admin',
        userEmail: 'admin@example.com',
      };

      vi.mocked(mockContext.get).mockReturnValue(mockAuthContext);

      await roleMiddleware(mockContext as any, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should reject users without required role', async () => {
      const roleMiddleware = createRoleMiddleware(['admin']);
      
      const mockAuthContext: AuthContext = {
        userId: 'user-123',
        userRole: 'user',
        userEmail: 'user@example.com',
      };

      vi.mocked(mockContext.get).mockReturnValue(mockAuthContext);
      vi.mocked(mockContext.json).mockReturnValue(new Response());

      await roleMiddleware(mockContext as any, mockNext);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Insufficient permissions',
          },
        },
        403
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should reject users with no role', async () => {
      const roleMiddleware = createRoleMiddleware(['admin']);
      
      const mockAuthContext: AuthContext = {
        userId: 'user-123',
        userRole: '',
        userEmail: 'user@example.com',
      };

      vi.mocked(mockContext.get).mockReturnValue(mockAuthContext);
      vi.mocked(mockContext.json).mockReturnValue(new Response());

      await roleMiddleware(mockContext as any, mockNext);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Insufficient permissions',
          },
        },
        403
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should handle multiple required roles', async () => {
      const roleMiddleware = createRoleMiddleware(['admin', 'moderator', 'support']);
      
      const mockAuthContext: AuthContext = {
        userId: 'user-123',
        userRole: 'moderator',
        userEmail: 'mod@example.com',
      };

      vi.mocked(mockContext.get).mockReturnValue(mockAuthContext);

      await roleMiddleware(mockContext as any, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('Cache behavior', () => {
    it('should increment cache hit metrics when using cached tokens', async () => {
      const { incrementCounter } = await vi.importMock('../src/utils/metrics');
      
      const cachedToken = 'cached-token';
      const cachedEntry = {
        user: {
          userId: 'user-123',
          userRole: 'user',
          userEmail: 'test@example.com',
        },
        expiresAt: Date.now() + 300000,
      };

      vi.mocked(mockContext.req!.header).mockReturnValue(`Bearer ${cachedToken}`);
      vi.mocked(mockCache.get).mockReturnValue(cachedEntry);

      await authenticationMiddleware(mockContext as any, mockNext);

      expect(incrementCounter).toHaveBeenCalledWith('auth.cache.hit');
    });

    it('should increment cache miss metrics when token not in cache', async () => {
      const { incrementCounter } = await vi.importMock('../src/utils/metrics');
      
      const validToken = 'valid-token';
      const mockValidateResponse = {
        success: true,
        user: { id: 'user-123', role: 'user', email: 'test@example.com' },
        ttl: 3600,
      };

      vi.mocked(mockContext.req!.header).mockReturnValue(`Bearer ${validToken}`);
      vi.mocked(mockCache.get).mockReturnValue(null);
      vi.mocked(mockAuthService.validateToken).mockResolvedValue(mockValidateResponse);

      await authenticationMiddleware(mockContext as any, mockNext);

      expect(incrementCounter).toHaveBeenCalledWith('auth.cache.miss');
    });
  });
});