import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { baseLogger } from './base';

describe('baseLogger', () => {
  // Mock console.log to prevent test output pollution
  beforeEach(() => {
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
});
