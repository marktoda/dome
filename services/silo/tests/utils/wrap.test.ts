import { describe, it, expect, vi, beforeEach } from 'vitest';
import { wrap } from '../../src/utils/wrap';

// Mock the logging module
vi.mock('@dome/logging', () => ({
  withLogger: vi.fn((meta, fn) => fn()),
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { withLogger, getLogger } from '@dome/logging';

describe('wrap utility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call withLogger with correct metadata', async () => {
    const meta = { operation: 'test', id: '123' };
    const fn = vi.fn().mockResolvedValue('result');

    await wrap(meta, fn);

    expect(withLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'test',
        id: '123',
        service: 'silo',
      }),
      expect.any(Function),
    );
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

    // Create a new mock for the logger
    const mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };

    // Override the getLogger mock for this test
    vi.mocked(getLogger).mockReturnValue(mockLogger as any);

    // Execute the function and catch the error
    try {
      await wrap({}, fn);
      // Should not reach here
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.message).toBe('Test error');

      // Verify the error was logged
      expect(mockLogger.error).toHaveBeenCalledWith({ err: error }, 'Unhandled error');
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
