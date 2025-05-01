import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildLoggingMiddleware, initLogging } from './middleware';
import { baseLogger } from './base';

// Mock nanoid
vi.mock('nanoid', () => ({
  nanoid: () => 'test-id-12345',
}));

// Mock Hono
const mockHono = {
  use: vi.fn(),
};

// Mock the hono/context-storage module
vi.mock('hono/context-storage', () => ({
  contextStorage: vi.fn(),
  getContext: vi.fn().mockReturnValue(null),
}));

describe('logging middleware', () => {
  // Mock console.log to prevent test output pollution
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.clearAllMocks();

    // Spy on baseLogger.child
    vi.spyOn(baseLogger, 'child').mockImplementation(bindings => {
      return {
        ...baseLogger,
        bindings: () => bindings,
      } as any;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should create middleware with default options', () => {
    const middleware = buildLoggingMiddleware();
    expect(middleware).toBeDefined();
    expect(typeof middleware).toBe('function');
  });

  it('should create middleware with custom options', () => {
    const idFactory = () => 'custom-id';
    const extraBindings = { app: 'test-app' };

    const middleware = buildLoggingMiddleware({
      idFactory,
      extraBindings,
    });

    expect(middleware).toBeDefined();
    expect(typeof middleware).toBe('function');
  });

  it('should initialize logging with Hono app', () => {
    initLogging(mockHono as any);

    expect(mockHono.use).toHaveBeenCalledTimes(2);
    expect(mockHono.use.mock.calls[1][0]).toBe('*');
  });

  it('should create a child logger with request context and set it in the Hono context', async () => {
    const middleware = buildLoggingMiddleware();

    // Create mock request context
    const mockContext = {
      req: {
        raw: {
          headers: {
            get: vi.fn(key => (key === 'cf-ray' ? 'test-ray-id' : null)),
          },
          cf: {
            colo: 'TEST',
          },
        },
        header: vi.fn(key => {
          if (key === 'CF-Connecting-IP') return '127.0.0.1';
          if (key === 'x-request-id') return undefined;
          if (key === 'cf-ray') return 'test-ray-id';
          return undefined;
        }),
        path: '/test',
        method: 'GET',
        url: 'https://example.com/test'
      },
      set: vi.fn(),
      header: vi.fn(),
      res: {
        status: 200,
        headers: new Headers()
      }
    };

    const mockNext = vi.fn().mockResolvedValue(undefined);

    // Execute the middleware
    await middleware(mockContext as any, mockNext);

    // Verify the child logger was created with the right bindings
    // The first arg is the metadata object, the second is options
    expect(baseLogger.child).toHaveBeenCalled();
    const firstCallFirstArg = (baseLogger.child as any).mock.calls[0][0];
    expect(firstCallFirstArg.reqId).toBe('test-id-12345');

    // Verify the logger was set in the context
    expect(mockContext.set).toHaveBeenCalledWith('logger', expect.anything());

    // Verify next() was called
    expect(mockNext).toHaveBeenCalled();
  });
});
