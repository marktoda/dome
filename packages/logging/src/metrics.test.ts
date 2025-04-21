import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MetricsService, metrics, logMetric, createTimer } from './metrics';
import { getLogger } from './getLogger';
import { createServiceMetrics } from './index';

// Mock the getLogger function
vi.mock('./getLogger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnValue({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
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

  describe('logMetric', () => {
    it('should log a metric with the correct structure', () => {
      const name = 'test_metric';
      const value = 123;
      const tags = { service: 'test-service' };

      logMetric(name, value, tags);

      expect(getLogger().info).toHaveBeenCalledWith(
        {
          metric_name: name,
          metric_value: value,
          metric_type: 'gauge',
          service: 'test-service',
        },
        'Metric recorded',
      );
    });

    it('should use the provided metric type if available', () => {
      const name = 'test_metric';
      const value = 123;
      const tags = { type: 'counter', service: 'test-service' };

      logMetric(name, value, tags);

      expect(getLogger().info).toHaveBeenCalledWith(
        {
          metric_name: name,
          metric_value: value,
          metric_type: 'counter',
          service: 'test-service',
        },
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

      expect(getLogger().info).toHaveBeenCalledWith(
        expect.objectContaining({
          metric_name: 'test_operation.duration_ms',
          metric_value: expect.any(Number),
          metric_type: 'timing',
        }),
        'Metric recorded',
      );
    });

    it('should support additional tags', () => {
      const timer = createTimer('test_operation');

      // Advance time by 100ms
      vi.advanceTimersByTime(100);

      // Stop the timer with tags
      timer.stop({ service: 'test-service' });

      expect(getLogger().info).toHaveBeenCalledWith(
        expect.objectContaining({
          metric_name: 'test_operation.duration_ms',
          metric_type: 'timing',
          service: 'test-service',
        }),
        'Metric recorded',
      );
    });
  });

  describe('MetricsService', () => {
    describe('increment', () => {
      it('should increment a counter and log the metric', () => {
        const metricsService = new MetricsService();

        metricsService.increment('test_counter');

        expect(getLogger().info).toHaveBeenCalledWith(
          expect.objectContaining({
            metric_name: 'test_counter',
            metric_value: 1,
            metric_type: 'counter',
          }),
          'Metric recorded',
        );

        // Increment again
        metricsService.increment('test_counter');

        expect(getLogger().info).toHaveBeenCalledWith(
          expect.objectContaining({
            metric_name: 'test_counter',
            metric_value: 2,
            metric_type: 'counter',
          }),
          'Metric recorded',
        );
      });

      it('should support custom increment values', () => {
        const metricsService = new MetricsService();

        metricsService.increment('test_counter', 5);

        expect(getLogger().info).toHaveBeenCalledWith(
          expect.objectContaining({
            metric_name: 'test_counter',
            metric_value: 5,
            metric_type: 'counter',
          }),
          'Metric recorded',
        );
      });

      it('should support additional tags', () => {
        const metricsService = new MetricsService();

        metricsService.increment('test_counter', 1, { service: 'test-service' });

        expect(getLogger().info).toHaveBeenCalledWith(
          expect.objectContaining({
            metric_name: 'test_counter',
            metric_value: 1,
            metric_type: 'counter',
            service: 'test-service',
          }),
          'Metric recorded',
        );
      });
    });

    describe('decrement', () => {
      it('should decrement a counter and log the metric', () => {
        const metricsService = new MetricsService();

        // Set initial value
        metricsService.increment('test_counter', 5);
        vi.clearAllMocks(); // Clear the increment call

        metricsService.decrement('test_counter');

        expect(getLogger().info).toHaveBeenCalledWith(
          expect.objectContaining({
            metric_name: 'test_counter',
            metric_value: 4,
            metric_type: 'counter',
          }),
          'Metric recorded',
        );
      });

      it('should not decrement below zero', () => {
        const metricsService = new MetricsService();

        metricsService.decrement('test_counter', 5);

        expect(getLogger().info).toHaveBeenCalledWith(
          expect.objectContaining({
            metric_name: 'test_counter',
            metric_value: 0,
            metric_type: 'counter',
          }),
          'Metric recorded',
        );
      });
    });

    describe('gauge', () => {
      it('should set a gauge value and log the metric', () => {
        const metricsService = new MetricsService();

        metricsService.gauge('test_gauge', 42);

        expect(getLogger().info).toHaveBeenCalledWith(
          expect.objectContaining({
            metric_name: 'test_gauge',
            metric_value: 42,
            metric_type: 'gauge',
          }),
          'Metric recorded',
        );
      });

      it('should support additional tags', () => {
        const metricsService = new MetricsService();

        metricsService.gauge('test_gauge', 42, { service: 'test-service' });

        expect(getLogger().info).toHaveBeenCalledWith(
          expect.objectContaining({
            metric_name: 'test_gauge',
            metric_value: 42,
            metric_type: 'gauge',
            service: 'test-service',
          }),
          'Metric recorded',
        );
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
    });

    describe('reset', () => {
      it('should reset all counters and gauges', () => {
        const metricsService = new MetricsService();

        metricsService.increment('test_counter', 5);
        metricsService.gauge('test_gauge', 42);

        metricsService.reset();

        expect(metricsService.getCounter('test_counter')).toBe(0);
        expect(metricsService.getGauge('test_gauge')).toBe(0);
        expect(getLogger().debug).toHaveBeenCalledWith('Metrics reset');
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

  // New tests for the standardized metrics interface
  describe('createServiceMetrics', () => {
    it('should create a service-specific metrics interface', () => {
      const serviceMetrics = createServiceMetrics('test-service');

      expect(serviceMetrics.counter).toBeDefined();
      expect(serviceMetrics.gauge).toBeDefined();
      expect(serviceMetrics.timing).toBeDefined();
      expect(serviceMetrics.startTimer).toBeDefined();
      expect(serviceMetrics.trackOperation).toBeDefined();
    });

    it('should prefix metric names with the service name', () => {
      const serviceMetrics = createServiceMetrics('test-service');
      const spy = vi.spyOn(metrics, 'increment');

      serviceMetrics.counter('requests', 1);

      expect(spy).toHaveBeenCalledWith('test-service.requests', 1, {});
    });

    it('should correctly pass through gauge metrics', () => {
      const serviceMetrics = createServiceMetrics('test-service');
      const spy = vi.spyOn(metrics, 'gauge');

      serviceMetrics.gauge('memory', 100, { region: 'us-east' });

      expect(spy).toHaveBeenCalledWith('test-service.memory', 100, { region: 'us-east' });
    });

    it('should correctly pass through timing metrics', () => {
      const serviceMetrics = createServiceMetrics('test-service');
      const spy = vi.spyOn(metrics, 'timing');

      serviceMetrics.timing('response_time', 42, { endpoint: '/api' });

      expect(spy).toHaveBeenCalledWith('test-service.response_time', 42, { endpoint: '/api' });
    });

    it('should create a timer with the service name prefix', () => {
      const serviceMetrics = createServiceMetrics('test-service');
      const mockTimer = { stop: vi.fn().mockReturnValue(100) };
      vi.spyOn(metrics, 'startTimer').mockReturnValue(mockTimer);

      const timer = serviceMetrics.startTimer('operation');

      expect(metrics.startTimer).toHaveBeenCalledWith('test-service.operation');
      expect(timer).toBe(mockTimer);
    });

    it('should correctly track operations with the service name prefix', () => {
      const serviceMetrics = createServiceMetrics('test-service');
      const spy = vi.spyOn(metrics, 'trackOperation');

      serviceMetrics.trackOperation('database_query', true, { table: 'users' });

      expect(spy).toHaveBeenCalledWith('test-service.database_query', true, { table: 'users' });
    });
  });
});
