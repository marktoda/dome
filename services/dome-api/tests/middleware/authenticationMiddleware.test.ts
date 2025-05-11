import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Context, Hono } from 'hono';
import { authenticationMiddleware, AuthContext } from '../../src/middleware/authenticationMiddleware';
// We will mock LRUCache constructor and its instance methods
import LRUCache from 'lru-cache';
import type { Bindings } from '../../src/types';

// Define a type for the logger mock
interface MockLogger {
  warn: any; // vi.Mock;
  debug: any; // vi.Mock;
  info: any; // vi.Mock;
  error: any; // vi.Mock;
  child: any; // vi.Mock<[], MockLogger>; // child returns MockLogger
}

const mockLoggerInstance: MockLogger = {
  warn: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLoggerInstance),
};

const mockAuthService = {
  validateToken: vi.fn(),
};

const mockServiceFactory = {
  getAuthService: vi.fn(() => mockAuthService),
};

const mockMetrics = {
  incrementCounter: vi.fn(),
  trackTiming: vi.fn((metricName: string) => (fn: () => Promise<any>) => fn()),
};

// Mock lru-cache
const mockLruCacheInstance = {
  get: vi.fn(),
  set: vi.fn(),
  clear: vi.fn(),
};
vi.mock('lru-cache', () => {
  return {
    default: vi.fn().mockImplementation(() => mockLruCacheInstance),
  };
});


vi.mock('@dome/common', async (importOriginal) => {
    const actual = await importOriginal() as any;
    return {
        ...actual,
        getLogger: vi.fn(() => mockLoggerInstance),
        logError: vi.fn(),
        updateContext: vi.fn().mockResolvedValue(undefined),
    };
});

vi.mock('../../src/services/serviceFactory', () => ({
  createServiceFactory: vi.fn(() => mockServiceFactory),
}));

vi.mock('../../src/utils/metrics', () => mockMetrics);


describe('authenticationMiddleware', () => {
  let mockContext: Context<{ Bindings: Bindings; Variables: { auth?: AuthContext } }>;
  let mockNext: any; // vi.Mock<[], Promise<void>>; // Typed mockNext

  const mockUser = { id: 'user-123', role: 'user', email: 'test@example.com' };
  const mockAuthContextData: AuthContext = {
    userId: mockUser.id,
    userRole: mockUser.role,
    userEmail: mockUser.email,
  };
  let dateSpy: any; // vi.SpyInstance<[], number>;


  beforeEach(async () => {
    vi.clearAllMocks();
    mockLruCacheInstance.get.mockClear();
    mockLruCacheInstance.set.mockClear();
    mockLruCacheInstance.clear.mockClear();


    mockNext = vi.fn().mockResolvedValue(undefined);

    mockContext = {
      req: {
        header: vi.fn(),
      },
      env: {} as Bindings,
      set: vi.fn(),
      get: vi.fn((key) => (key === 'auth' ? (mockContext as any).var?.auth : undefined)),
      json: vi.fn(),
      header: vi.fn(),
      var: {},
    } as unknown as Context<{ Bindings: Bindings; Variables: { auth?: AuthContext } }>;
  });

  afterEach(() => {
    if (dateSpy) {
      dateSpy.mockRestore();
    }
    vi.restoreAllMocks();
  });

  it('should return 401 if Authorization header is missing', async () => {
    (mockContext.req.header as any).mockReturnValue(undefined); // Cast to any
    await authenticationMiddleware(mockContext as any, mockNext);
    expect(mockContext.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: { code: 'UNAUTHORIZED' } }), 401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should return 401 if Authorization header does not start with "Bearer "', async () => {
    (mockContext.req.header as any).mockReturnValue('Invalid token'); // Cast to any
    await authenticationMiddleware(mockContext as any, mockNext);
    expect(mockContext.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: { code: 'UNAUTHORIZED' } }), 401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should authenticate from cache if token is valid and cached', async () => {
    const token = 'valid-cached-token';
    const cachedEntry = { user: mockAuthContextData, expiresAt: Date.now() + 100000 };
    mockLruCacheInstance.get.mockReturnValue(cachedEntry);
    (mockContext.req.header as any).mockReturnValue(`Bearer ${token}`); // Cast to any

    await authenticationMiddleware(mockContext as any, mockNext);

    expect(mockMetrics.incrementCounter).toHaveBeenCalledWith('auth.cache.hit');
    expect(mockContext.set).toHaveBeenCalledWith('auth', cachedEntry.user);
    expect(mockAuthService.validateToken).not.toHaveBeenCalled();
    expect(mockNext).toHaveBeenCalled();
    const baggageValue = `user=${Buffer.from(JSON.stringify({id: cachedEntry.user.userId, role: cachedEntry.user.userRole, email: cachedEntry.user.userEmail})).toString('base64url')}`;
    expect(mockContext.header).toHaveBeenCalledWith('baggage', baggageValue);
  });

  it('should not use expired cached token and call authService', async () => {
    const token = 'expired-cached-token';
    const cachedEntry = { user: mockAuthContextData, expiresAt: Date.now() - 100000 };
    mockLruCacheInstance.get.mockReturnValue(cachedEntry);
    (mockContext.req.header as any).mockReturnValue(`Bearer ${token}`); // Cast to any
    mockAuthService.validateToken.mockResolvedValue({ success: true, user: mockUser, ttl: 300 });

    await authenticationMiddleware(mockContext as any, mockNext);

    expect(mockMetrics.incrementCounter).toHaveBeenCalledWith('auth.cache.miss');
    expect(mockAuthService.validateToken).toHaveBeenCalledWith(token);
    expect(mockContext.set).toHaveBeenCalledWith('auth', mockAuthContextData);
    expect(mockNext).toHaveBeenCalled();
  });

  it('should call authService if token not in cache, then cache it and set context', async () => {
    const token = 'valid-new-token';
    mockLruCacheInstance.get.mockReturnValue(undefined);
    (mockContext.req.header as any).mockReturnValue(`Bearer ${token}`); // Cast to any
    mockAuthService.validateToken.mockResolvedValue({ success: true, user: mockUser, ttl: 300 });

    await authenticationMiddleware(mockContext as any, mockNext);

    expect(mockMetrics.incrementCounter).toHaveBeenCalledWith('auth.cache.miss');
    expect(mockMetrics.trackTiming).toHaveBeenCalledWith('auth.service.call_duration');
    expect(mockAuthService.validateToken).toHaveBeenCalledWith(token);
    expect(mockContext.set).toHaveBeenCalledWith('auth', mockAuthContextData);
    expect(mockLruCacheInstance.set).toHaveBeenCalledWith(token, expect.objectContaining({ user: mockAuthContextData }));
    expect(mockNext).toHaveBeenCalled();
    const baggageValue = `user=${Buffer.from(JSON.stringify({id: mockUser.id, role: mockUser.role, email: mockUser.email})).toString('base64url')}`;
    expect(mockContext.header).toHaveBeenCalledWith('baggage', baggageValue);
  });

  it('should return 401 if authService returns invalid token', async () => {
    const token = 'invalid-token';
    mockLruCacheInstance.get.mockReturnValue(undefined);
    (mockContext.req.header as any).mockReturnValue(`Bearer ${token}`); // Cast to any
    mockAuthService.validateToken.mockResolvedValue({ success: false, user: null });

    await authenticationMiddleware(mockContext as any, mockNext);

    expect(mockAuthService.validateToken).toHaveBeenCalledWith(token);
    expect(mockContext.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: { code: 'UNAUTHORIZED' } }), 401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should return 401 if authService throws an error', async () => {
    const token = 'error-token';
    mockLruCacheInstance.get.mockReturnValue(undefined);
    (mockContext.req.header as any).mockReturnValue(`Bearer ${token}`); // Cast to any
    mockAuthService.validateToken.mockRejectedValue(new Error('Auth service unavailable'));

    await authenticationMiddleware(mockContext as any, mockNext);

    expect(mockAuthService.validateToken).toHaveBeenCalledWith(token);
    expect(mockContext.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication failed' } }), 401);
    expect(mockNext).not.toHaveBeenCalled();
    expect(mockLoggerInstance.error).toHaveBeenCalled();
  });

   it('should use default TTL for cache if authService returns no TTL', async () => {
    const token = 'no-ttl-token';
    mockLruCacheInstance.get.mockReturnValue(undefined);
    (mockContext.req.header as any).mockReturnValue(`Bearer ${token}`); // Cast to any
    mockAuthService.validateToken.mockResolvedValue({ success: true, user: mockUser, ttl: undefined });

    const now = Date.now();
    dateSpy = vi.spyOn(Date, 'now').mockReturnValue(now);

    await authenticationMiddleware(mockContext as any, mockNext);

    expect(mockAuthService.validateToken).toHaveBeenCalledWith(token);
    expect(mockLruCacheInstance.set).toHaveBeenCalledWith(token, {
      user: mockAuthContextData,
      expiresAt: now + 300 * 1000,
    });
    dateSpy.mockRestore();
  });

  it('should use shorter of service TTL and max cache TTL (300s)', async () => {
    const token = 'long-ttl-token';
    mockLruCacheInstance.get.mockReturnValue(undefined);
    (mockContext.req.header as any).mockReturnValue(`Bearer ${token}`); // Cast to any
    mockAuthService.validateToken.mockResolvedValue({ success: true, user: mockUser, ttl: 1000 });

    const now = Date.now();
    dateSpy = vi.spyOn(Date, 'now').mockReturnValue(now);

    await authenticationMiddleware(mockContext as any, mockNext);

    expect(mockLruCacheInstance.set).toHaveBeenCalledWith(token, {
      user: mockAuthContextData,
      expiresAt: now + 300 * 1000,
    });
    dateSpy.mockRestore();
  });
});