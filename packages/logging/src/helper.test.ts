import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { baseLogger } from './base';
import { getLogger } from './helper';

// Mock the entire module with a simple implementation
vi.mock('hono/context-storage', () => {
  const mockGetContext = vi.fn();
  return {
    getContext: mockGetContext,
  };
});

// Import the mocked module after mocking
import { getContext } from 'hono/context-storage';

describe('getLogger', () => {
  // Mock console.log to prevent test output pollution
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return base logger when no context is available', () => {
    // Mock getContext to return null (no context)
    (getContext as any).mockReturnValue(null);

    const logger = getLogger();

    expect(logger).toBeDefined();
    expect(logger).toBe(baseLogger);
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.warn).toBe('function');
  });

  it('should return context logger when available', () => {
    // Create a mock context with a logger
    const mockLogger = baseLogger.child({ requestId: 'test-123' });
    const mockContext = {
      get: vi.fn((key: string) => (key === 'logger' ? mockLogger : undefined)),
      set: vi.fn(),
    };

    // Mock getContext to return our mock context
    (getContext as any).mockReturnValue(mockContext);

    const logger = getLogger();

    expect(logger).toBeDefined();
    expect(logger).toBe(mockLogger);
    expect(mockContext.get).toHaveBeenCalledWith('logger');
  });

  it('should handle exceptions and return base logger', () => {
    // Mock getContext to throw an error
    (getContext as any).mockImplementation(() => {
      throw new Error('Context access error');
    });

    const logger = getLogger();

    expect(logger).toBeDefined();
    expect(logger).toBe(baseLogger);
    expect(console.log).toHaveBeenCalled();
  });
});
