import { describe, it, expect, vi, beforeEach } from 'vitest';
import { wrap } from '../../src/utils/wrap';

// Mock the common module
vi.mock('@dome/common', () => {
  const mockLogger: {
    info: any;
    error: any;
    warn: any;
    debug: any;
    child: any;
  } = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => mockLogger),
  };

  return {
    withContext: vi.fn((meta, fn) => fn(mockLogger)),
    getLogger: vi.fn(() => mockLogger),
    logError: vi.fn(),
    trackOperation: vi.fn((name, fn, meta) => fn()),
    createServiceWrapper: vi.fn((serviceName: string) => {
      return async (meta: Record<string, unknown>, fn: () => Promise<any>) => {
        return withContext({ ...meta, service: serviceName }, async () => {
          try {
            return await fn();
          } catch (error) {
            mockLogger.error({ err: error }, 'Unhandled error');
            throw error;
          }
        });
      };
    }),
  };
});

import { withContext, getLogger, createServiceWrapper } from '@dome/common';

describe('wrap utility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should use createServiceWrapper with correct service name', async () => {
    // Verify that the wrap function is using createServiceWrapper
    expect(createServiceWrapper).toHaveBeenCalledWith('silo');

    // Reset mocks for this test
    vi.clearAllMocks();

    const meta = { operation: 'test', id: '123' };
    const fn = vi.fn().mockResolvedValue('result');

    await wrap(meta, fn);

    // Verify withContext was called with the right metadata
    expect(withContext).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'test',
        id: '123',
        service: 'silo',
      }),
      expect.any(Function),
    );

    // Verify the function was called
    expect(fn).toHaveBeenCalled();
  });

  it('should return the result of the wrapped function', async () => {
    const fn = vi.fn().mockResolvedValue('test-result');
    const result = await wrap({}, fn);
    expect(result).toBe('test-result');
  });

  it('should log and rethrow errors', async () => {
    const error = new Error('Test error');
    const fn = vi.fn().mockRejectedValue(error);
    const logger = getLogger();

    // Execute the function and catch the error
    try {
      await wrap({}, fn);
      // Should not reach here
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.message).toBe('Test error');

      // Verify the error was logged
      expect(logger.error).toHaveBeenCalledWith({ err: error }, 'Unhandled error');
    }
  });

  it('should preserve error type when rethrowing', async () => {
    class CustomError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'CustomError';
      }
    }

    const error = new CustomError('Custom error');
    const fn = vi.fn().mockRejectedValue(error);

    await expect(wrap({}, fn)).rejects.toThrow(CustomError);
  });
});
