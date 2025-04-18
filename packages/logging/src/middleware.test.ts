import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildLoggingMiddleware, initLogging } from './middleware';

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
  getContext: vi.fn().mockReturnValue(null)
}));

describe('logging middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});