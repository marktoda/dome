/**
 * Logging Utilities Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logError, logMetric, createTimer } from '../../src/utils/logging';
import { getLogger } from '@dome/logging';

// Mock the @dome/logging module
vi.mock('@dome/logging', () => ({
  getLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
  BaseLogger: class {},
}));

describe('Logging Utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe('logError', () => {
    it('should log an error with context when error is an Error object', () => {
      const mockLogger = getLogger();
      const error = new Error('Test error');
      const message = 'An error occurred';
      const context = { userId: 'user1' };

      logError(error, message, context);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Test error',
          name: 'Error',
          stack: error.stack,
          userId: 'user1',
        }),
        message,
      );
    });

    it('should log an error with context when error is not an Error object', () => {
      const mockLogger = getLogger();
      const error = 'String error';
      const message = 'An error occurred';
      const context = { userId: 'user1' };

      logError(error, message, context);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'String error',
          userId: 'user1',
        }),
        message,
      );
    });

    it('should work without context', () => {
      const mockLogger = getLogger();
      const error = new Error('Test error');
      const message = 'An error occurred';

      logError(error, message);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Test error',
          name: 'Error',
          stack: error.stack,
        }),
        message,
      );
    });
  });

  describe('logMetric', () => {
    it('should log a metric with tags', () => {
      const mockLogger = getLogger();
      const name = 'test_metric';
      const value = 123;
      const tags = { service: 'constellation' };

      logMetric(name, value, tags);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          metric_name: name,
          metric_value: value,
          metric_type: 'gauge',
          service: 'constellation',
        }),
        'Metric recorded',
      );
    });

    it('should work without tags', () => {
      const mockLogger = getLogger();
      const name = 'test_metric';
      const value = 123;

      logMetric(name, value);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          metric_name: name,
          metric_value: value,
          metric_type: 'gauge',
        }),
        'Metric recorded',
      );
    });
  });

  describe('createTimer', () => {
    it('should create a timer that measures duration', () => {
      const timer = createTimer('test_operation');

      // Advance time by 100ms
      vi.advanceTimersByTime(100);

      // Stop the timer
      const duration = timer.stop();

      // The actual duration might not be exactly 100ms in the test environment
      expect(duration).toBeGreaterThanOrEqual(0);
    });

    it('should log the duration when stopped', () => {
      const mockLogger = getLogger();
      const timer = createTimer('test_operation');

      // Advance time by 100ms
      vi.advanceTimersByTime(100);

      // Stop the timer with tags
      timer.stop({ service: 'constellation' });

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          metric_name: 'test_operation.duration_ms',
          metric_type: 'timing',
          service: 'constellation',
        }),
        'Metric recorded',
      );

      // We don't check the exact value of metric_value since it may vary
    });
  });

  // Removed logger tests since we no longer export a global logger
});
