import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { baseLogger } from './base';

describe('baseLogger', () => {
  // Mock console.log to prevent test output pollution
  beforeEach(() => {
    // Clear all mocks before each test
    vi.clearAllMocks();

    // Mock console.log to capture logs
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // Temporarily set LOG_LEVEL to info for testing
    const originalLogLevel = (globalThis as any).LOG_LEVEL;
    (globalThis as any).LOG_LEVEL = 'info';

    return () => {
      // Restore original LOG_LEVEL
      (globalThis as any).LOG_LEVEL = originalLogLevel;
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should be defined', () => {
    expect(baseLogger).toBeDefined();
  });

  it('should have standard logging methods', () => {
    expect(typeof baseLogger.info).toBe('function');
    expect(typeof baseLogger.error).toBe('function');
    expect(typeof baseLogger.debug).toBe('function');
    expect(typeof baseLogger.warn).toBe('function');
    expect(typeof baseLogger.trace).toBe('function');
    expect(typeof baseLogger.fatal).toBe('function');
  });

  it('should create child loggers with additional context', () => {
    const childLogger = baseLogger.child({ service: 'test-service' });
    expect(childLogger).toBeDefined();
    expect(typeof childLogger.info).toBe('function');
    expect(typeof childLogger.error).toBe('function');
  });

  it('should have logging methods that can be called', () => {
    // We're not testing actual logging behavior here, just that the methods don't throw
    expect(() => {
      baseLogger.info('test info message');
      baseLogger.error('test error message');
    }).not.toThrow();
  });

  it('should standardize logging format with string message', () => {
    const consoleSpy = vi.spyOn(console, 'log');

    baseLogger.info('test message');

    expect(consoleSpy).toHaveBeenCalled();
    const loggedObj = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(loggedObj).toHaveProperty('message', 'test message');
  });

  it('should standardize logging format with object and string message', () => {
    const consoleSpy = vi.spyOn(console, 'log');

    baseLogger.info({ userId: '123' }, 'test message');

    expect(consoleSpy).toHaveBeenCalled();
    const loggedObj = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(loggedObj).toHaveProperty('userId', '123');
    expect(loggedObj).toHaveProperty('message', 'test message');
  });

  it('should handle object with message property correctly', () => {
    const consoleSpy = vi.spyOn(console, 'log');

    baseLogger.info({ userId: '123', message: 'test message' });

    expect(consoleSpy).toHaveBeenCalled();
    const loggedObj = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(loggedObj).toHaveProperty('userId', '123');
    expect(loggedObj).toHaveProperty('message', 'test message');
  });

  it('should standardize logging in child loggers', () => {
    const consoleSpy = vi.spyOn(console, 'log');

    const childLogger = baseLogger.child({ service: 'test-service' });
    childLogger.info({ userId: '123' }, 'test message');

    expect(consoleSpy).toHaveBeenCalled();
    const loggedObj = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(loggedObj).toHaveProperty('service', 'test-service');
    expect(loggedObj).toHaveProperty('userId', '123');
    expect(loggedObj).toHaveProperty('message', 'test message');
  });
});
