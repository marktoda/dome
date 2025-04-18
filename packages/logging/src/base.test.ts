import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { baseLogger } from './base';

describe('baseLogger', () => {
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
});