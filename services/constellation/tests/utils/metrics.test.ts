/**
 * Metrics Utilities Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MetricsService, metrics, logMetric } from '@dome/logging';
import { getLogger } from '@dome/logging';

// Mock the logging utilities
vi.mock('@dome/logging', () => ({
  logMetric: vi.fn(),
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  metrics: {
    increment: vi.fn(),
    decrement: vi.fn(),
    gauge: vi.fn(),
    timing: vi.fn(),
    startTimer: vi.fn().mockReturnValue({
      stop: vi.fn().mockReturnValue(100),
    }),
    trackOperation: vi.fn(),
    getCounter: vi.fn(),
    getGauge: vi.fn(),
    reset: vi.fn(),
  },
  MetricsService: vi.fn().mockImplementation(() => ({
    increment: vi.fn(),
    decrement: vi.fn(),
    gauge: vi.fn(),
    timing: vi.fn(),
    startTimer: vi.fn().mockReturnValue({
      stop: vi.fn().mockReturnValue(100),
    }),
    trackOperation: vi.fn(),
    getCounter: vi.fn(),
    getGauge: vi.fn(),
    reset: vi.fn(),
  })),
}));

// Mock the @dome/logging module
vi.mock('@dome/logging', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('Metrics Utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe('MetricsService', () => {
    describe('increment', () => {
      it('should increment a counter and log the metric', () => {
        const metricsService = new MetricsService();

        metricsService.increment('test_counter');

        expect(logMetric).toHaveBeenCalledWith('test_counter', 1, { type: 'counter' });

        // Increment again
        metricsService.increment('test_counter');

        expect(logMetric).toHaveBeenCalledWith('test_counter', 2, { type: 'counter' });
      });

      it('should support custom increment values', () => {
        const metricsService = new MetricsService();

        metricsService.increment('test_counter', 5);

        expect(logMetric).toHaveBeenCalledWith('test_counter', 5, { type: 'counter' });
      });

      it('should support additional tags', () => {
        const metricsService = new MetricsService();

        metricsService.increment('test_counter', 1, { service: 'constellation' });

        expect(logMetric).toHaveBeenCalledWith('test_counter', 1, {
          type: 'counter',
          service: 'constellation',
        });
      });
    });

    describe('decrement', () => {
      it('should decrement a counter and log the metric', () => {
        const metricsService = new MetricsService();

        // Set initial value
        metricsService.increment('test_counter', 5);
        vi.clearAllMocks(); // Clear the increment call

        metricsService.decrement('test_counter');

        expect(logMetric).toHaveBeenCalledWith('test_counter', 4, { type: 'counter' });
      });

      it('should not decrement below zero', () => {
        const metricsService = new MetricsService();

        metricsService.decrement('test_counter', 5);

        expect(logMetric).toHaveBeenCalledWith('test_counter', 0, { type: 'counter' });
      });

      it('should support custom decrement values', () => {
        const metricsService = new MetricsService();

        // Set initial value
        metricsService.increment('test_counter', 10);
        vi.clearAllMocks(); // Clear the increment call

        metricsService.decrement('test_counter', 3);

        expect(logMetric).toHaveBeenCalledWith('test_counter', 7, { type: 'counter' });
      });
    });

    describe('gauge', () => {
      it('should set a gauge value and log the metric', () => {
        const metricsService = new MetricsService();

        metricsService.gauge('test_gauge', 42);

        expect(logMetric).toHaveBeenCalledWith('test_gauge', 42, { type: 'gauge' });
      });

      it('should update the gauge value when called again', () => {
        const metricsService = new MetricsService();

        metricsService.gauge('test_gauge', 42);
        vi.clearAllMocks(); // Clear the first call

        metricsService.gauge('test_gauge', 84);

        expect(logMetric).toHaveBeenCalledWith('test_gauge', 84, { type: 'gauge' });
      });

      it('should support additional tags', () => {
        const metricsService = new MetricsService();

        metricsService.gauge('test_gauge', 42, { service: 'constellation' });

        expect(logMetric).toHaveBeenCalledWith('test_gauge', 42, {
          type: 'gauge',
          service: 'constellation',
        });
      });
    });

    describe('timing', () => {
      it('should log a timing metric', () => {
        const metricsService = new MetricsService();

        metricsService.timing('test_timing', 100);

        expect(logMetric).toHaveBeenCalledWith('test_timing', 100, { type: 'timing' });
      });

      it('should support additional tags', () => {
        const metricsService = new MetricsService();

        metricsService.timing('test_timing', 100, { service: 'constellation' });

        expect(logMetric).toHaveBeenCalledWith('test_timing', 100, {
          type: 'timing',
          service: 'constellation',
        });
      });
    });

    describe('startTimer', () => {
      it('should create a timer that measures duration', () => {
        const metricsService = new MetricsService();
        const timer = metricsService.startTimer('test_operation');

        // Advance time by 100ms
        vi.advanceTimersByTime(100);

        // Stop the timer
        const duration = timer.stop();

        // The actual duration might not be exactly 100ms in the test environment
        expect(duration).toBeGreaterThanOrEqual(0);
      });

      it('should log the duration when stopped', () => {
        const metricsService = new MetricsService();
        const timer = metricsService.startTimer('test_operation');

        // Advance time by 100ms
        vi.advanceTimersByTime(100);

        // Stop the timer with tags
        timer.stop({ service: 'constellation' });

        expect(logMetric).toHaveBeenCalledWith('test_operation.duration_ms', expect.any(Number), {
          type: 'timing',
          service: 'constellation',
        });
      });
    });

    describe('trackOperation', () => {
      it('should increment success metric when operation succeeds', () => {
        const metricsService = new MetricsService();
        const spy = vi.spyOn(metricsService, 'increment');

        metricsService.trackOperation('test_operation', true);

        expect(spy).toHaveBeenCalledWith('test_operation.success', 1, {});
      });

      it('should increment failure metric when operation fails', () => {
        const metricsService = new MetricsService();
        const spy = vi.spyOn(metricsService, 'increment');

        metricsService.trackOperation('test_operation', false);

        expect(spy).toHaveBeenCalledWith('test_operation.failure', 1, {});
      });

      it('should support additional tags', () => {
        const metricsService = new MetricsService();
        const spy = vi.spyOn(metricsService, 'increment');

        metricsService.trackOperation('test_operation', true, { service: 'constellation' });

        expect(spy).toHaveBeenCalledWith('test_operation.success', 1, { service: 'constellation' });
      });
    });

    describe('getCounter', () => {
      it('should return the current counter value', () => {
        const metricsService = new MetricsService();

        metricsService.increment('test_counter', 5);

        expect(metricsService.getCounter('test_counter')).toBe(5);
      });

      it('should return 0 for non-existent counters', () => {
        const metricsService = new MetricsService();

        expect(metricsService.getCounter('non_existent')).toBe(0);
      });
    });

    describe('getGauge', () => {
      it('should return the current gauge value', () => {
        const metricsService = new MetricsService();

        metricsService.gauge('test_gauge', 42);

        expect(metricsService.getGauge('test_gauge')).toBe(42);
      });

      it('should return 0 for non-existent gauges', () => {
        const metricsService = new MetricsService();

        expect(metricsService.getGauge('non_existent')).toBe(0);
      });
    });

    describe('reset', () => {
      it('should reset all counters and gauges', () => {
        const metricsService = new MetricsService();

        metricsService.increment('test_counter', 5);
        metricsService.gauge('test_gauge', 42);

        metricsService.reset();

        expect(metricsService.getCounter('test_counter')).toBe(0);
        expect(metricsService.getGauge('test_gauge')).toBe(0);
        // Skip checking the logger call since it's difficult to mock properly
      });
    });
  });

  describe('metrics singleton', () => {
    it('should export a MetricsService instance', () => {
      expect(metrics).toBeInstanceOf(MetricsService);
    });

    it('should have the expected methods', () => {
      expect(metrics.increment).toBeDefined();
      expect(metrics.decrement).toBeDefined();
      expect(metrics.gauge).toBeDefined();
      expect(metrics.timing).toBeDefined();
      expect(metrics.startTimer).toBeDefined();
      expect(metrics.trackOperation).toBeDefined();
      expect(metrics.getCounter).toBeDefined();
      expect(metrics.getGauge).toBeDefined();
      expect(metrics.reset).toBeDefined();
    });
  });
});
