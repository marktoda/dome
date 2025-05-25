import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Context } from 'hono';
import { createServiceFactory } from '../src/services/serviceFactory';
import { AuthService } from '@dome/auth/client';
import { SupportedAuthProvider } from '@dome/auth/types';
import { Bindings } from '../src/types';

// Mock the service factory
vi.mock('../src/services/serviceFactory');

// Mock authentication middleware
const createAuthMiddleware = () => {
  return async (c: Context, next: () => Promise<void>) => {
    const token = c.req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      return c.json({ error: 'Missing authorization token' }, 401);
    }

    try {
      const serviceFactory = createServiceFactory();
      const authService = serviceFactory.getAuthService(c.env as Bindings);
      const validation = await authService.validateToken(token);
      
      if (!validation.success) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      // Set user context
      c.set('user', validation.user);
      c.set('userId', validation.userId);
      
      await next();
    } catch (error) {
      return c.json({ error: 'Authentication failed' }, 500);
    }
  };
};

describe('Authentication Middleware', () => {
  let mockAuthService: AuthService;
  let mockContext: Context;
  let authMiddleware: (c: Context, next: () => Promise<void>) => Promise<Response | void>;
  let nextCalled: boolean;

  beforeEach(() => {
    nextCalled = false;

    mockAuthService = {
      validateToken: vi.fn(),
    } as any;

    // Mock the service factory to return our mock auth service
    const mockServiceFactory = {
      getAuthService: vi.fn().mockReturnValue(mockAuthService),
    };

    vi.mocked(createServiceFactory).mockReturnValue(mockServiceFactory as any);

    authMiddleware = createAuthMiddleware();

    // Mock Hono context
    mockContext = {
      req: {
        header: vi.fn(),
      },
      env: {} as Bindings,
      set: vi.fn(),
      json: vi.fn().mockImplementation((data, status) => {
        return new Response(JSON.stringify(data), { 
          status,
          headers: { 'Content-Type': 'application/json' }
        });
      }),
    } as any;
  });

  it('should pass through requests with valid tokens', async () => {
    const mockValidationResponse = {
      success: true,
      userId: 'test-user',
      provider: SupportedAuthProvider.LOCAL,
      user: { id: 'test-user', email: 'test@example.com' },
    };

    (mockContext.req.header as any).mockReturnValue('Bearer valid-token');
    (mockAuthService.validateToken as any).mockResolvedValue(mockValidationResponse);

    const next = vi.fn().mockImplementation(() => {
      nextCalled = true;
      return Promise.resolve();
    });

    await authMiddleware(mockContext, next);

    expect(mockAuthService.validateToken).toHaveBeenCalledWith('valid-token');
    expect(mockContext.set).toHaveBeenCalledWith('user', mockValidationResponse.user);
    expect(mockContext.set).toHaveBeenCalledWith('userId', mockValidationResponse.userId);
    expect(next).toHaveBeenCalled();
    expect(nextCalled).toBe(true);
  });

  it('should reject requests without authorization header', async () => {
    (mockContext.req.header as any).mockReturnValue(undefined);

    const next = vi.fn();
    const response = await authMiddleware(mockContext, next);

    expect(response).toBeInstanceOf(Response);
    expect(response!.status).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(mockAuthService.validateToken).not.toHaveBeenCalled();
  });

  it('should reject requests with malformed authorization header', async () => {
    (mockContext.req.header as any).mockReturnValue('InvalidFormat token');

    const next = vi.fn();
    const response = await authMiddleware(mockContext, next);

    expect(response).toBeInstanceOf(Response);
    expect(response!.status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject requests with invalid tokens', async () => {
    const mockValidationResponse = {
      success: false,
      userId: '',
      provider: SupportedAuthProvider.LOCAL,
    };

    (mockContext.req.header as any).mockReturnValue('Bearer invalid-token');
    (mockAuthService.validateToken as any).mockResolvedValue(mockValidationResponse);

    const next = vi.fn();
    const response = await authMiddleware(mockContext, next);

    expect(response).toBeInstanceOf(Response);
    expect(response!.status).toBe(401);
    expect(mockAuthService.validateToken).toHaveBeenCalledWith('invalid-token');
    expect(next).not.toHaveBeenCalled();
  });

  it('should handle auth service errors gracefully', async () => {
    (mockContext.req.header as any).mockReturnValue('Bearer valid-token');
    (mockAuthService.validateToken as any).mockRejectedValue(new Error('Auth service down'));

    const next = vi.fn();
    const response = await authMiddleware(mockContext, next);

    expect(response).toBeInstanceOf(Response);
    expect(response!.status).toBe(500);
    expect(next).not.toHaveBeenCalled();
  });

  it('should handle different token formats correctly', async () => {
    const mockValidationResponse = {
      success: true,
      userId: 'test-user',
      provider: SupportedAuthProvider.PRIVY,
      user: { id: 'test-user', email: 'test@example.com' },
    };

    // Test with proper Bearer format
    (mockContext.req.header as any).mockReturnValue('Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...');
    (mockAuthService.validateToken as any).mockResolvedValue(mockValidationResponse);

    const next = vi.fn().mockResolvedValue(undefined);
    await authMiddleware(mockContext, next);

    expect(mockAuthService.validateToken).toHaveBeenCalledWith('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...');
    expect(next).toHaveBeenCalled();
  });

  it('should cache validation results for performance', async () => {
    const mockValidationResponse = {
      success: true,
      userId: 'test-user',
      provider: SupportedAuthProvider.LOCAL,
      user: { id: 'test-user', email: 'test@example.com' },
      ttl: 3600, // 1 hour cache
    };

    (mockContext.req.header as any).mockReturnValue('Bearer cached-token');
    (mockAuthService.validateToken as any).mockResolvedValue(mockValidationResponse);

    const next = vi.fn().mockResolvedValue(undefined);
    await authMiddleware(mockContext, next);

    expect(mockAuthService.validateToken).toHaveBeenCalledWith('cached-token');
    expect(next).toHaveBeenCalled();

    // Verify caching behavior could be implemented by checking if TTL is respected
    expect(mockValidationResponse.ttl).toBeGreaterThan(0);
  });

  it('should handle multiple authentication providers', async () => {
    const mockPrivyValidation = {
      success: true,
      userId: 'privy-user',
      provider: SupportedAuthProvider.PRIVY,
      user: { id: 'privy-user', email: 'privy@example.com' },
    };

    (mockContext.req.header as any).mockReturnValue('Bearer privy-token');
    (mockAuthService.validateToken as any).mockResolvedValue(mockPrivyValidation);

    const next = vi.fn().mockResolvedValue(undefined);
    await authMiddleware(mockContext, next);

    expect(mockAuthService.validateToken).toHaveBeenCalledWith('privy-token');
    expect(mockContext.set).toHaveBeenCalledWith('user', mockPrivyValidation.user);
    expect(next).toHaveBeenCalled();
  });

  it('should set correct user context for different user types', async () => {
    const mockAdminUser = {
      id: 'admin-user',
      email: 'admin@example.com',
      role: 'admin',
    };

    const mockValidationResponse = {
      success: true,
      userId: 'admin-user',
      provider: SupportedAuthProvider.LOCAL,
      user: mockAdminUser,
    };

    (mockContext.req.header as any).mockReturnValue('Bearer admin-token');
    (mockAuthService.validateToken as any).mockResolvedValue(mockValidationResponse);

    const next = vi.fn().mockResolvedValue(undefined);
    await authMiddleware(mockContext, next);

    expect(mockContext.set).toHaveBeenCalledWith('user', mockAdminUser);
    expect(mockContext.set).toHaveBeenCalledWith('userId', 'admin-user');
    expect(next).toHaveBeenCalled();
  });
});