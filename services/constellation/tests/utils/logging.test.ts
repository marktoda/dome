/**
 * Logging Utilities Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logError, logMetric, createTimer, logger } from '../../src/utils/logging';
import { getLogger } from '@dome/logging';

// Mock the @dome/logging module
vi.mock('@dome/logging', () => ({
  getLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn()
  }),
  BaseLogger: class {}
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
          userId: 'user1'
        }),
        message
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
          userId: 'user1'
        }),
        message
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
          stack: error.stack
        }),
        message
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
          metric: name,
          value,
          service: 'constellation'
        }),
        `Metric: ${name}`
      );
    });
    
    it('should work without tags', () => {
      const mockLogger = getLogger();
      const name = 'test_metric';
      const value = 123;
      
      logMetric(name, value);
      
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          metric: name,
          value
        }),
        `Metric: ${name}`
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
      
      // Should be approximately 100ms
      expect(duration).toBe(100);
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
          metric: 'test_operation.duration_ms',
          value: 100,
          service: 'constellation'
        }),
        'Metric: test_operation.duration_ms'
      );
    });
  });
  
  describe('logger', () => {
    it('should export the logger from @dome/logging', () => {
      expect(logger).toBe(getLogger());
    });
    
    it('should have the expected methods', () => {
      expect(logger.info).toBeDefined();
      expect(logger.error).toBeDefined();
      expect(logger.warn).toBeDefined();
      expect(logger.debug).toBeDefined();
    });
  });
});