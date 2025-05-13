import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Context, Hono } from 'hono';
import { authenticationMiddleware, AuthContext } from '../../src/middleware/authenticationMiddleware';
// We will mock LRUCache constructor and its instance methods
import LRUCache from 'lru-cache';
import type { Bindings } from '../../src/types';
import { incrementCounter, trackTiming } from '../../src/utils/metrics'; // Import the actuals (will be mocked)
import { logError as actualLogError } from '@dome/common'; // Import to spy on the mocked version

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

// Define mockMetrics, but it won't be used in a variable reference in the vi.mock factory below
// const mockMetrics = {
//  incrementCounter: vi.fn(),
//  trackTiming: vi.fn((metricName: string) => (fn: () => Promise<any>) => fn()),
// };

// Mock lru-cache using vi.hoisted to ensure mock functions are initialized before the factory
const { mockLruGet, mockLruSet, mockLruClear } = vi.hoisted(() => {
  return {
    mockLruGet: vi.fn(),
    mockLruSet: vi.fn(),
    mockLruClear: vi.fn(),
  };
});

vi.mock('lru-cache', () => {
  // This factory is for the default export of 'lru-cache', which is the LRUCache constructor.
  // It needs to return a constructor that, when called (new LRUCache()), returns an object with get, set, clear methods.
  return {
    default: vi.fn().mockImplementation(() => ({
      get: mockLruGet, // These are now from vi.hoisted, so they are initialized
      set: mockLruSet,
      clear: mockLruClear,
    })),
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

vi.mock('../../src/utils/metrics', () => ({
  incrementCounter: vi.fn(),
  trackTiming: vi.fn((metricName: string) => (fn: () => Promise<any>) => fn()),
  // Ensure all exports from ../../src/utils/metrics are mocked if needed by the SUT
}));


describe('authenticationMiddleware', () => {
  let mockContext: Context<{ Bindings: Bindings; Variables: { auth?: AuthContext } }>;
  let mockNext: any; // vi.Mock<[], Promise<void>>; // Typed mockNext

  const mockUser = { id: 'user-123', role: 'user', email: 'test@example.com' };
  const mockAuthContextData: AuthContext = {
    userId: mockUser.id,
    userRole: mockUser.role,
    userEmail: mockUser.email,
  };
  let dateSpy: ReturnType<typeof vi.spyOn>;


  beforeEach(async () => {
    vi.clearAllMocks();
    // Clear the new mock functions
    mockLruGet.mockClear();
    mockLruSet.mockClear();
    mockLruClear.mockClear();

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
    expect(mockContext.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }), 401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should return 401 if Authorization header does not start with "Bearer "', async () => {
    (mockContext.req.header as any).mockReturnValue('Invalid token'); // Cast to any
    await authenticationMiddleware(mockContext as any, mockNext);
    expect(mockContext.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }), 401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should authenticate from cache if token is valid and cached', async () => {
    const token = 'valid-cached-token';
    const cachedEntry = { user: mockAuthContextData, expiresAt: Date.now() + 100000 };
    mockLruGet.mockReturnValue(cachedEntry);
    (mockContext.req.header as any).mockReturnValue(`Bearer ${token}`); // Cast to any

    await authenticationMiddleware(mockContext as any, mockNext);

    expect(incrementCounter).toHaveBeenCalledWith('auth.cache.hit');
    expect(mockContext.set).toHaveBeenCalledWith('auth', cachedEntry.user);
    expect(mockAuthService.validateToken).not.toHaveBeenCalled();
    expect(mockNext).toHaveBeenCalled();
    const baggageValue = `user=${Buffer.from(JSON.stringify({id: cachedEntry.user.userId, role: cachedEntry.user.userRole, email: cachedEntry.user.userEmail})).toString('base64url')}`;
    expect(mockContext.header).toHaveBeenCalledWith('baggage', baggageValue);
  });

  it('should not use expired cached token and call authService', async () => {
    const token = 'expired-cached-token';
    const cachedEntry = { user: mockAuthContextData, expiresAt: Date.now() - 100000 };
    mockLruGet.mockReturnValue(cachedEntry);
    (mockContext.req.header as any).mockReturnValue(`Bearer ${token}`); // Cast to any
    mockAuthService.validateToken.mockResolvedValue({ success: true, user: mockUser, ttl: 300, provider: "privy", userId: mockUser.id });

    await authenticationMiddleware(mockContext as any, mockNext);

    expect(incrementCounter).toHaveBeenCalledWith('auth.cache.miss');
    expect(mockAuthService.validateToken).toHaveBeenCalledWith(token, "privy");
    expect(mockContext.set).toHaveBeenCalledWith('auth', mockAuthContextData);
    expect(mockNext).toHaveBeenCalled();
  });

  it('should call authService if token not in cache, then cache it and set context', async () => {
    const token = 'valid-new-token';
    mockLruGet.mockReturnValue(undefined);
    (mockContext.req.header as any).mockReturnValue(`Bearer ${token}`); // Cast to any
    mockAuthService.validateToken.mockResolvedValue({ success: true, user: mockUser, ttl: 300, provider: "privy", userId: mockUser.id });

    await authenticationMiddleware(mockContext as any, mockNext);

    expect(incrementCounter).toHaveBeenCalledWith('auth.cache.miss');
    expect(trackTiming).toHaveBeenCalledWith('auth.service.call_duration');
    expect(mockAuthService.validateToken).toHaveBeenCalledWith(token, "privy");
    expect(mockContext.set).toHaveBeenCalledWith('auth', mockAuthContextData);
    expect(mockLruSet).toHaveBeenCalledWith(token, expect.objectContaining({ user: mockAuthContextData }));
    expect(mockNext).toHaveBeenCalled();
    const baggageValue = `user=${Buffer.from(JSON.stringify({id: mockUser.id, role: mockUser.role, email: mockUser.email})).toString('base64url')}`;
    expect(mockContext.header).toHaveBeenCalledWith('baggage', baggageValue);
  });

  it('should return 401 if authService returns invalid token', async () => {
    const token = 'invalid-token';
    mockLruGet.mockReturnValue(undefined);
    (mockContext.req.header as any).mockReturnValue(`Bearer ${token}`); // Cast to any
    mockAuthService.validateToken.mockResolvedValue({ success: false, user: null, provider: "privy", userId: '' }); // Ensure provider and userId are present even on failure

    await authenticationMiddleware(mockContext as any, mockNext);

    expect(mockAuthService.validateToken).toHaveBeenCalledWith(token, "privy");
    expect(mockContext.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } }), 401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should return 401 if authService throws an error', async () => {
    const token = 'error-token';
    mockLruGet.mockReturnValue(undefined);
    (mockContext.req.header as any).mockReturnValue(`Bearer ${token}`); // Cast to any
    mockAuthService.validateToken.mockRejectedValue(new Error('Auth service unavailable'));

    await authenticationMiddleware(mockContext as any, mockNext);

    expect(mockAuthService.validateToken).toHaveBeenCalledWith(token, "privy");
    // The actual middleware catches the error and logs it, then returns a generic auth failed.
    // The specific error message from the exception might not propagate to the JSON response here
    // if the catch block in the middleware standardizes it.
    expect(mockContext.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication failed' } }), 401);
    expect(mockNext).not.toHaveBeenCalled();
    expect(actualLogError).toHaveBeenCalled(); // Check if the mocked logError was called
  });

   it('should use default TTL for cache if authService returns no TTL', async () => {
    const token = 'no-ttl-token';
    mockLruGet.mockReturnValue(undefined);
    (mockContext.req.header as any).mockReturnValue(`Bearer ${token}`); // Cast to any
    mockAuthService.validateToken.mockResolvedValue({ success: true, user: mockUser, ttl: undefined, provider: "privy", userId: mockUser.id });

    const now = Date.now();
    dateSpy = vi.spyOn(Date, 'now').mockReturnValue(now);

    await authenticationMiddleware(mockContext as any, mockNext);

    expect(mockAuthService.validateToken).toHaveBeenCalledWith(token, "privy");
    expect(mockLruSet).toHaveBeenCalledWith(token, {
      user: mockAuthContextData,
      expiresAt: now + 300 * 1000, // Default TTL is 300s
    });
    dateSpy.mockRestore();
  });

  it('should use shorter of service TTL and max cache TTL (300s)', async () => {
    const token = 'long-ttl-token';
    mockLruGet.mockReturnValue(undefined);
    (mockContext.req.header as any).mockReturnValue(`Bearer ${token}`); // Cast to any
    mockAuthService.validateToken.mockResolvedValue({ success: true, user: mockUser, ttl: 1000, provider: "privy", userId: mockUser.id });

    const now = Date.now();
    dateSpy = vi.spyOn(Date, 'now').mockReturnValue(now);

    await authenticationMiddleware(mockContext as any, mockNext);

    expect(mockLruSet).toHaveBeenCalledWith(token, {
      user: mockAuthContextData,
      expiresAt: now + 300 * 1000, // Max cache TTL is 300s
    });
    dateSpy.mockRestore();
  });
});