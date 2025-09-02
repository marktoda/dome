import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { 
  createError, 
  toError, 
  getErrorMessage, 
  logError,
  retry,
  timeout
} from './errors.js';

// Mock the logger module
vi.mock('./logger.js', () => ({
  default: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn()
  }
}));

describe('Error Utilities', () => {
  let mockLogger: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockLogger = (await import('./logger.js')).default;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('createError', () => {
    it('should create an error with default code and status', () => {
      const error = createError('Test error message');
      
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe('Test error message');
      expect((error as any).code).toBe('DOME_ERROR');
      expect((error as any).statusCode).toBe(500);
    });

    it('should create an error with custom code', () => {
      const error = createError('Not found', 'NOT_FOUND', 404);
      
      expect(error.message).toBe('Not found');
      expect((error as any).code).toBe('NOT_FOUND');
      expect((error as any).statusCode).toBe(404);
    });

    it('should create an error with custom status code', () => {
      const error = createError('Unauthorized', 'UNAUTHORIZED', 401);
      
      expect(error.message).toBe('Unauthorized');
      expect((error as any).code).toBe('UNAUTHORIZED');
      expect((error as any).statusCode).toBe(401);
    });

    it('should handle empty message', () => {
      const error = createError('');
      
      expect(error.message).toBe('');
      expect((error as any).code).toBe('DOME_ERROR');
    });
  });

  describe('toError', () => {
    it('should return Error instance as-is', () => {
      const originalError = new Error('Original error');
      const result = toError(originalError);
      
      expect(result).toBe(originalError);
      expect(result.message).toBe('Original error');
    });

    it('should convert string to Error', () => {
      const result = toError('String error message');
      
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe('String error message');
    });

    it('should convert number to Error', () => {
      const result = toError(404);
      
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe('404');
    });

    it('should convert object to Error', () => {
      const result = toError({ code: 'ERROR', details: 'Something went wrong' });
      
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe('[object Object]');
    });

    it('should convert null to Error', () => {
      const result = toError(null);
      
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe('null');
    });

    it('should convert undefined to Error', () => {
      const result = toError(undefined);
      
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe('undefined');
    });

    it('should convert boolean to Error', () => {
      const result = toError(false);
      
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe('false');
    });

    it('should handle custom error classes', () => {
      class CustomError extends Error {
        constructor(message: string) {
          super(message);
          this.name = 'CustomError';
        }
      }
      
      const customError = new CustomError('Custom error');
      const result = toError(customError);
      
      expect(result).toBe(customError);
      expect(result).toBeInstanceOf(CustomError);
      expect(result.message).toBe('Custom error');
    });
  });

  describe('getErrorMessage', () => {
    it('should extract message from Error instance', () => {
      const error = new Error('Error message');
      const message = getErrorMessage(error);
      
      expect(message).toBe('Error message');
    });

    it('should return string as-is', () => {
      const message = getErrorMessage('String error');
      
      expect(message).toBe('String error');
    });

    it('should convert number to string', () => {
      const message = getErrorMessage(500);
      
      expect(message).toBe('500');
    });

    it('should convert object to string', () => {
      const message = getErrorMessage({ error: 'details' });
      
      expect(message).toBe('[object Object]');
    });

    it('should handle null', () => {
      const message = getErrorMessage(null);
      
      expect(message).toBe('null');
    });

    it('should handle undefined', () => {
      const message = getErrorMessage(undefined);
      
      expect(message).toBe('undefined');
    });

    it('should handle empty string', () => {
      const message = getErrorMessage('');
      
      expect(message).toBe('');
    });

    it('should handle error with empty message', () => {
      const error = new Error('');
      const message = getErrorMessage(error);
      
      expect(message).toBe('');
    });
  });

  describe('logError', () => {
    it('should log error without context', () => {
      const error = new Error('Test error');
      logError(error);
      
      expect(mockLogger.error).toHaveBeenCalledWith(
        { context: undefined, code: undefined },
        'Test error'
      );
    });

    it('should log error with context', () => {
      const error = new Error('Database error');
      logError(error, 'Database');
      
      expect(mockLogger.error).toHaveBeenCalledWith(
        { context: 'Database', code: undefined },
        'Database error'
      );
    });

    it('should log error with code', () => {
      const error = createError('Not found', 'NOT_FOUND', 404);
      logError(error, 'API');
      
      expect(mockLogger.error).toHaveBeenCalledWith(
        { context: 'API', code: 'NOT_FOUND' },
        'Not found'
      );
    });

    it('should convert string to error and log', () => {
      logError('String error', 'StringContext');
      
      expect(mockLogger.error).toHaveBeenCalledWith(
        { context: 'StringContext', code: undefined },
        'String error'
      );
    });

    it('should convert unknown type to error and log', () => {
      logError({ some: 'object' }, 'ObjectContext');
      
      expect(mockLogger.error).toHaveBeenCalledWith(
        { context: 'ObjectContext', code: undefined },
        '[object Object]'
      );
    });

    it('should handle null error', () => {
      logError(null, 'NullContext');
      
      expect(mockLogger.error).toHaveBeenCalledWith(
        { context: 'NullContext', code: undefined },
        'null'
      );
    });
  });

  describe('retry', () => {
    it('should succeed on first attempt', async () => {
      const fn = vi.fn().mockResolvedValue('success');
      
      const result = await retry(fn);
      
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on failure and eventually succeed', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('First fail'))
        .mockRejectedValueOnce(new Error('Second fail'))
        .mockResolvedValueOnce('success');
      
      vi.useFakeTimers();
      
      const promise = retry(fn, 3, 100);
      
      // First attempt fails immediately
      await vi.advanceTimersByTimeAsync(0);
      expect(fn).toHaveBeenCalledTimes(1);
      
      // Second attempt after 100ms
      await vi.advanceTimersByTimeAsync(100);
      expect(fn).toHaveBeenCalledTimes(2);
      
      // Third attempt after 200ms (100ms * 2)
      await vi.advanceTimersByTimeAsync(200);
      expect(fn).toHaveBeenCalledTimes(3);
      
      const result = await promise;
      expect(result).toBe('success');
    });

    it('should throw last error after max attempts', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('First fail'))
        .mockRejectedValueOnce(new Error('Second fail'))
        .mockRejectedValueOnce(new Error('Final fail'));
      
      vi.useFakeTimers();
      
      const promise = retry(fn, 3, 100);
      
      // Attach rejection handler immediately to avoid unhandled rejection
      const resultPromise = expect(promise).rejects.toThrow('Final fail');
      
      // Advance through all retry attempts
      await vi.advanceTimersByTimeAsync(0);   // First attempt
      await vi.advanceTimersByTimeAsync(100); // Second attempt
      await vi.advanceTimersByTimeAsync(200); // Third attempt
      
      await resultPromise;
      expect(fn).toHaveBeenCalledTimes(3);
      
      vi.useRealTimers();
    });

    it('should use exponential backoff', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('Fail 1'))
        .mockRejectedValueOnce(new Error('Fail 2'))
        .mockResolvedValueOnce('success');
      
      vi.useFakeTimers();
      
      const startTime = Date.now();
      const promise = retry(fn, 3, 100);
      
      // First attempt at 0ms
      await vi.advanceTimersByTimeAsync(0);
      expect(fn).toHaveBeenCalledTimes(1);
      
      // Second attempt after 100ms (100ms * 1)
      await vi.advanceTimersByTimeAsync(100);
      expect(fn).toHaveBeenCalledTimes(2);
      
      // Third attempt after 200ms more (100ms * 2)
      await vi.advanceTimersByTimeAsync(200);
      expect(fn).toHaveBeenCalledTimes(3);
      
      const result = await promise;
      expect(result).toBe('success');
      
      vi.useRealTimers();
    });

    it('should handle single attempt (no retry)', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('Single fail'));
      
      await expect(retry(fn, 1)).rejects.toThrow('Single fail');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should use default values when not specified', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('Fail'))
        .mockResolvedValueOnce('success');
      
      vi.useFakeTimers();
      
      const promise = retry(fn);
      
      await vi.advanceTimersByTimeAsync(0);   // First attempt
      await vi.advanceTimersByTimeAsync(1000); // Second attempt (default 1000ms)
      
      const result = await promise;
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe('timeout', () => {
    it('should resolve if promise completes before timeout', async () => {
      const promise = Promise.resolve('success');
      
      const result = await timeout(promise, 1000);
      
      expect(result).toBe('success');
    });

    it('should reject if promise takes longer than timeout', async () => {
      vi.useFakeTimers();
      
      const slowPromise = new Promise(resolve => 
        setTimeout(() => resolve('too late'), 2000)
      );
      
      const timeoutPromise = timeout(slowPromise, 1000);
      
      // Advance timer to trigger timeout
      vi.advanceTimersByTime(1000);
      
      await expect(timeoutPromise).rejects.toThrow('Operation timed out after 1000ms');
    });

    it('should use custom timeout message', async () => {
      vi.useFakeTimers();
      
      const slowPromise = new Promise(resolve => 
        setTimeout(() => resolve('too late'), 2000)
      );
      
      const timeoutPromise = timeout(slowPromise, 500, 'Custom timeout message');
      
      vi.advanceTimersByTime(500);
      
      await expect(timeoutPromise).rejects.toThrow('Custom timeout message');
    });

    it('should preserve original promise rejection', async () => {
      const rejectedPromise = Promise.reject(new Error('Original error'));
      
      await expect(timeout(rejectedPromise, 1000)).rejects.toThrow('Original error');
    });

    it('should handle zero timeout', async () => {
      vi.useFakeTimers();
      
      const promise = new Promise(resolve => 
        setTimeout(() => resolve('result'), 10)
      );
      
      const timeoutPromise = timeout(promise, 0);
      
      vi.advanceTimersByTime(0);
      
      await expect(timeoutPromise).rejects.toThrow('Operation timed out after 0ms');
    });

    it('should handle negative timeout as immediate timeout', async () => {
      vi.useFakeTimers();
      
      const promise = new Promise(resolve => 
        setTimeout(() => resolve('result'), 10)
      );
      
      const timeoutPromise = timeout(promise, -100);
      
      // Negative timeout should trigger immediately
      vi.advanceTimersByTime(0);
      
      await expect(timeoutPromise).rejects.toThrow('Operation timed out after -100ms');
    });

    it('should work with async functions', async () => {
      const asyncFn = async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        return 'async result';
      };
      
      vi.useFakeTimers();
      
      const timeoutPromise = timeout(asyncFn(), 200);
      
      vi.advanceTimersByTime(100);
      
      const result = await timeoutPromise;
      expect(result).toBe('async result');
    });

    it('should handle promise that resolves exactly at timeout', async () => {
      vi.useFakeTimers();
      
      const promise = new Promise(resolve => 
        setTimeout(() => resolve('just in time'), 1000)
      );
      
      const timeoutPromise = timeout(promise, 1000);
      
      // Advance to exactly the timeout
      vi.advanceTimersByTime(1000);
      
      // Race condition - could go either way, but should not hang
      try {
        const result = await timeoutPromise;
        expect(result).toBe('just in time');
      } catch (error: any) {
        expect(error.message).toBe('Operation timed out after 1000ms');
      }
    });
  });

  describe('Integration scenarios', () => {
    it('should combine retry with timeout', async () => {
      vi.useFakeTimers();
      
      let attempts = 0;
      const slowFn = async () => {
        attempts++;
        await new Promise(resolve => setTimeout(resolve, 2000));
        return 'slow result';
      };
      
      const retryWithTimeout = () => retry(
        () => timeout(slowFn(), 500),
        3,
        100
      );
      
      const promise = retryWithTimeout();
      
      // Attach rejection handler immediately to avoid unhandled rejection
      const resultPromise = expect(promise).rejects.toThrow('Operation timed out after 500ms');
      
      // First attempt times out after 500ms
      await vi.advanceTimersByTimeAsync(500);
      expect(attempts).toBe(1);
      
      // Wait for retry delay (100ms)
      await vi.advanceTimersByTimeAsync(100);
      
      // Second attempt times out after 500ms
      await vi.advanceTimersByTimeAsync(500);
      expect(attempts).toBe(2);
      
      // Wait for retry delay (200ms)
      await vi.advanceTimersByTimeAsync(200);
      
      // Third attempt times out after 500ms
      await vi.advanceTimersByTimeAsync(500);
      expect(attempts).toBe(3);
      
      await resultPromise;
      
      vi.useRealTimers();
    });

    it('should log errors during retry', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('Retry error 1'))
        .mockResolvedValueOnce('success');
      
      vi.useFakeTimers();
      
      const retryWithLogging = async () => {
        try {
          return await retry(fn, 2, 100);
        } catch (error) {
          logError(error, 'RetryContext');
          throw error;
        }
      };
      
      const promise = retryWithLogging();
      
      await vi.advanceTimersByTimeAsync(0);   // First attempt fails
      await vi.advanceTimersByTimeAsync(100); // Second attempt succeeds
      
      const result = await promise;
      expect(result).toBe('success');
      
      // Logger should not be called since retry succeeded
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('should create and log custom errors', () => {
      const error = createError('Custom error', 'CUSTOM_CODE', 400);
      logError(error, 'CustomContext');
      
      expect(mockLogger.error).toHaveBeenCalledWith(
        { context: 'CustomContext', code: 'CUSTOM_CODE' },
        'Custom error'
      );
    });
  });
});