import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Context, Hono } from 'hono';
import { authenticationMiddleware, AuthContext } from '../../src/middleware/authenticationMiddleware';
// We will mock LRUCache constructor and its instance methods
import LRUCache from 'lru-cache';
import type { Bindings } from '../../src/types';

// Define a type for the logger mock
interface MockLogger {
  warn: vi.Mock;
  debug: vi.Mock;
  info: vi.Mock;
  error: vi.Mock;
  child: vi.Mock<[], MockLogger>; // child returns MockLogger
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
  // Add other methods if the middleware uses them
};
vi.mock('lru-cache', () => {
  return {
    // Default export for new LRUCache(...)
    default: vi.fn().mockImplementation(() => mockLruCacheInstance),
  };
});


vi.mock('@dome/common', async (importOriginal) => {
    const actual = await importOriginal() as any; // Cast to any if actual structure is complex
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
  // Hono app is not strictly necessary for unit testing the middleware function directly
  // let app: Hono<{ Bindings: Bindings; Variables: { auth?: AuthContext } }>;
  let mockContext: Context<{ Bindings: Bindings; Variables: { auth?: AuthContext } }>;
  let mockNext: vi.Mock<[], Promise<void>>; // Typed mockNext

  const mockUser = { id: 'user-123', role: 'user', email: 'test@example.com' };
  const mockAuthContextData: AuthContext = {
    userId: mockUser.id,
    userRole: mockUser.role,
    userEmail: mockUser.email,
  };
  let dateSpy: vi.SpyInstance<[], number>;


  beforeEach(async () => { // Made beforeEach async
    vi.clearAllMocks();
    mockLruCacheInstance.get.mockClear();
    mockLruCacheInstance.set.mockClear();
    mockLruCacheInstance.clear.mockClear();
    // Since LRUCache is mocked, its constructor will be called when the middleware module is loaded.
    // We ensure our mockLruCacheInstance is used.

    mockNext = vi.fn().mockResolvedValue(undefined);

    mockContext = {
      req: {
        header: vi.fn(), // Properly mock req.header
      },
      env: {} as Bindings,
      set: vi.fn(),
      get: vi.fn((key) => (key === 'auth' ? (mockContext as any).var?.auth : undefined)),
      json: vi.fn(),
      header: vi.fn(),
      var: {}, // Initialize var for c.set('auth', ...)
    } as unknown as Context<{ Bindings: Bindings; Variables: { auth?: AuthContext } }>;
  });

  afterEach(() => {
    if (dateSpy) {
      dateSpy.mockRestore();
    }
    vi.restoreAllMocks();
  });

  it('should return 401 if Authorization header is missing', async () => {
    (mockContext.req.header as vi.Mock).mockReturnValue(undefined);
    await authenticationMiddleware(mockContext as any, mockNext); // Cast context to any
    expect(mockContext.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: { code: 'UNAUTHORIZED' } }), 401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should return 401 if Authorization header does not start with "Bearer "', async () => {
    (mockContext.req.header as vi.Mock).mockReturnValue('Invalid token');
    await authenticationMiddleware(mockContext as any, mockNext); // Cast context to any
    expect(mockContext.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: { code: 'UNAUTHORIZED' } }), 401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should authenticate from cache if token is valid and cached', async () => {
    const token = 'valid-cached-token';
    const cachedEntry = { user: mockAuthContextData, expiresAt: Date.now() + 100000 };
    mockLruCacheInstance.get.mockReturnValue(cachedEntry);
    (mockContext.req.header as vi.Mock).mockReturnValue(`Bearer ${token}`);

    await authenticationMiddleware(mockContext as any, mockNext); // Cast context to any

    expect(mockMetrics.incrementCounter).toHaveBeenCalledWith('auth.cache.hit');
    expect(mockContext.set).toHaveBeenCalledWith('auth', cachedEntry.user);
    expect(mockAuthService.validateToken).not.toHaveBeenCalled();
    expect(mockNext).toHaveBeenCalled();
    const baggageValue = `user=${Buffer.from(JSON.stringify({id: cachedEntry.user.userId, role: cachedEntry.user.userRole, email: cachedEntry.user.userEmail})).toString('base64url')}`;
    expect(mockContext.header).toHaveBeenCalledWith('baggage', baggageValue);
  });

  it('should not use expired cached token and call authService', async () => {
    const token = 'expired-cached-token';
    const cachedEntry = { user: mockAuthContextData, expiresAt: Date.now() - 100000 }; // Expired
    mockLruCacheInstance.get.mockReturnValue(cachedEntry);
    (mockContext.req.header as vi.Mock).mockReturnValue(`Bearer ${token}`);
    mockAuthService.validateToken.mockResolvedValue({ success: true, user: mockUser, ttl: 300 });

    await authenticationMiddleware(mockContext as any, mockNext); // Cast context to any

    expect(mockMetrics.incrementCounter).toHaveBeenCalledWith('auth.cache.miss');
    expect(mockAuthService.validateToken).toHaveBeenCalledWith(token);
    expect(mockContext.set).toHaveBeenCalledWith('auth', mockAuthContextData);
    expect(mockNext).toHaveBeenCalled();
  });

  it('should call authService if token not in cache, then cache it and set context', async () => {
    const token = 'valid-new-token';
    mockLruCacheInstance.get.mockReturnValue(undefined); // Cache miss
    (mockContext.req.header as vi.Mock).mockReturnValue(`Bearer ${token}`);
    mockAuthService.validateToken.mockResolvedValue({ success: true, user: mockUser, ttl: 300 });

    await authenticationMiddleware(mockContext as any, mockNext); // Cast context to any

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
    (mockContext.req.header as vi.Mock).mockReturnValue(`Bearer ${token}`);
    mockAuthService.validateToken.mockResolvedValue({ success: false, user: null });

    await authenticationMiddleware(mockContext as any, mockNext); // Cast context to any

    expect(mockAuthService.validateToken).toHaveBeenCalledWith(token);
    expect(mockContext.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: { code: 'UNAUTHORIZED' } }), 401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should return 401 if authService throws an error', async () => {
    const token = 'error-token';
    mockLruCacheInstance.get.mockReturnValue(undefined);
    (mockContext.req.header as vi.Mock).mockReturnValue(`Bearer ${token}`);
    mockAuthService.validateToken.mockRejectedValue(new Error('Auth service unavailable'));

    await authenticationMiddleware(mockContext as any, mockNext); // Cast context to any

    expect(mockAuthService.validateToken).toHaveBeenCalledWith(token);
    expect(mockContext.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication failed' } }), 401);
    expect(mockNext).not.toHaveBeenCalled();
    expect(mockLoggerInstance.error).toHaveBeenCalled();
  });

   it('should use default TTL for cache if authService returns no TTL', async () => {
    const token = 'no-ttl-token';
    mockLruCacheInstance.get.mockReturnValue(undefined);
    (mockContext.req.header as vi.Mock).mockReturnValue(`Bearer ${token}`);
    mockAuthService.validateToken.mockResolvedValue({ success: true, user: mockUser, ttl: undefined });

    const now = Date.now(); // Capture current time before mocking
    dateSpy = vi.spyOn(Date, 'now').mockReturnValue(now);

    await authenticationMiddleware(mockContext as any, mockNext); // Cast context to any

    expect(mockAuthService.validateToken).toHaveBeenCalledWith(token);
    expect(mockLruCacheInstance.set).toHaveBeenCalledWith(token, {
      user: mockAuthContextData,
      expiresAt: now + 300 * 1000, // Default TTL is 300 seconds
    });
    dateSpy.mockRestore(); // Restore Date.now
  });

  it('should use shorter of service TTL and max cache TTL (300s)', async () => {
    const token = 'long-ttl-token';
    mockLruCacheInstance.get.mockReturnValue(undefined);
    (mockContext.req.header as vi.Mock).mockReturnValue(`Bearer ${token}`);
    mockAuthService.validateToken.mockResolvedValue({ success: true, user: mockUser, ttl: 1000 }); // Service TTL > 300s

    const now = Date.now();
    dateSpy = vi.spyOn(Date, 'now').mockReturnValue(now);

    await authenticationMiddleware(mockContext as any, mockNext); // Cast context to any

    expect(mockLruCacheInstance.set).toHaveBeenCalledWith(token, {
      user: mockAuthContextData,
      expiresAt: now + 300 * 1000, // Cache TTL should be capped at 300s
    });
    dateSpy.mockRestore();
  });
});