import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServiceMetrics, createMetrics } from './metrics';

// Mock the @dome/logging dependency
vi.mock('@dome/logging', () => ({
  metrics: {
    increment: vi.fn(),
    gauge: vi.fn(),
    timing: vi.fn(),
  },
}));

// Import the mocked dependency after mocking
import { metrics as domeMetrics } from '@dome/logging';

describe('ServiceMetrics', () => {
  let metrics: ServiceMetrics;
  
  beforeEach(() => {
    metrics = new ServiceMetrics('test-service', { region: 'us-east' });
    vi.clearAllMocks();
  });

  describe('constructor and initialization', () => {
    it('should create a metrics service instance with the correct prefix', () => {
      expect(metrics).toBeInstanceOf(ServiceMetrics);
    });

    it('should initialize with environment variables', () => {
      metrics.init({ VERSION: '1.0.0', ENVIRONMENT: 'testing' });
      
      // Test a method that uses the initialized values
      metrics.counter('test');
      expect(domeMetrics.increment).toHaveBeenCalledWith(
        'test_service.test',
        1,
        expect.objectContaining({
          service: 'test-service',
          version: '1.0.0',
          environment: 'testing',
          region: 'us-east',
        })
      );
    });
  });

  describe('counter', () => {
    it('should increment a counter with default value of 1', () => {
      metrics.counter('test');
      expect(domeMetrics.increment).toHaveBeenCalledWith(
        'test_service.test',
        1,
        expect.any(Object)
      );
    });

    it('should increment a counter with specified value', () => {
      metrics.counter('test', 5);
      expect(domeMetrics.increment).toHaveBeenCalledWith(
        'test_service.test',
        5,
        expect.any(Object)
      );
    });

    it('should include tags when incrementing a counter', () => {
      metrics.counter('test', 1, { tag1: 'value1' });
      expect(domeMetrics.increment).toHaveBeenCalledWith(
        'test_service.test',
        1,
        expect.objectContaining({ tag1: 'value1' })
      );
    });

    it('should track counter values internally', () => {
      metrics.counter('internal', 3);
      metrics.counter('internal', 2);
      expect(metrics.getCounter('internal')).toBe(5);
    });
  });

  describe('gauge', () => {
    it('should set a gauge value', () => {
      metrics.gauge('test', 42);
      expect(domeMetrics.gauge).toHaveBeenCalledWith(
        'test_service.test',
        42,
        expect.any(Object)
      );
    });

    it('should include tags when setting a gauge', () => {
      metrics.gauge('test', 42, { tag1: 'value1' });
      expect(domeMetrics.gauge).toHaveBeenCalledWith(
        'test_service.test',
        42,
        expect.objectContaining({ tag1: 'value1' })
      );
    });
  });

  describe('timing', () => {
    it('should record a timing value', () => {
      metrics.timing('test', 100);
      expect(domeMetrics.timing).toHaveBeenCalledWith(
        'test_service.test',
        100,
        expect.any(Object)
      );
    });

    it('should include tags when recording a timing', () => {
      metrics.timing('test', 100, { tag1: 'value1' });
      expect(domeMetrics.timing).toHaveBeenCalledWith(
        'test_service.test',
        100,
        expect.objectContaining({ tag1: 'value1' })
      );
    });
  });

  describe('startTimer', () => {
    it('should create a timer that records duration when stopped', () => {
      // Mock performance.now to return controlled values
      const originalNow = performance.now;
      performance.now = vi.fn()
        .mockReturnValueOnce(1000) // Start time
        .mockReturnValueOnce(1100); // End time (100ms later)

      const timer = metrics.startTimer('operation');
      const duration = timer.stop();

      expect(duration).toBe(100);
      expect(domeMetrics.timing).toHaveBeenCalledWith(
        'test_service.operation.duration_ms',
        100,
        expect.any(Object)
      );

      // Restore the original performance.now
      performance.now = originalNow;
    });

    it('should pass through tags to the timing call', () => {
      // Mock performance.now
      const originalNow = performance.now;
      performance.now = vi.fn()
        .mockReturnValueOnce(1000)
        .mockReturnValueOnce(1100);

      const timer = metrics.startTimer('operation', { initialTag: 'value' });
      timer.stop({ finalTag: 'value' });

      expect(domeMetrics.timing).toHaveBeenCalledWith(
        'test_service.operation.duration_ms',
        100,
        expect.objectContaining({
          initialTag: 'value',
          finalTag: 'value'
        })
      );

      // Restore the original performance.now
      performance.now = originalNow;
    });
  });

  describe('trackOperation', () => {
    it('should track a successful operation', () => {
      metrics.trackOperation('process', true);
      
      expect(domeMetrics.increment).toHaveBeenCalledWith(
        'test_service.process.success',
        1,
        expect.any(Object)
      );
      
      expect(domeMetrics.gauge).toHaveBeenCalledWith(
        'test_service.process.success_rate',
        1,
        expect.any(Object)
      );
    });

    it('should track a failed operation', () => {
      metrics.trackOperation('process', false);
      
      expect(domeMetrics.increment).toHaveBeenCalledWith(
        'test_service.process.failure',
        1,
        expect.any(Object)
      );
      
      expect(domeMetrics.gauge).toHaveBeenCalledWith(
        'test_service.process.success_rate',
        0,
        expect.any(Object)
      );
    });
  });

  describe('trackApiRequest', () => {
    it('should track an API request', () => {
      metrics.trackApiRequest('/api/data', 'GET', 200, 150);
      
      expect(domeMetrics.increment).toHaveBeenCalledWith(
        'test_service.api.request',
        1,
        expect.objectContaining({
          path: '/api/data',
          method: 'GET',
          status_code: '200',
          status_category: '2xx'
        })
      );
      
      expect(domeMetrics.timing).toHaveBeenCalledWith(
        'test_service.api.request_duration_ms',
        150,
        expect.objectContaining({
          path: '/api/data',
          method: 'GET',
          status_code: '200',
          status_category: '2xx'
        })
      );
    });

    it('should track an API error', () => {
      metrics.trackApiRequest('/api/data', 'GET', 500, 150);
      
      expect(domeMetrics.increment).toHaveBeenCalledWith(
        'test_service.api.error',
        1,
        expect.objectContaining({
          status_code: '500',
          status_category: '5xx'
        })
      );
    });
  });

  describe('trackHealthCheck', () => {
    it('should track a successful health check', () => {
      metrics.trackHealthCheck('ok', 50, 'database');
      
      expect(domeMetrics.increment).toHaveBeenCalledWith(
        'test_service.health.check',
        1,
        expect.objectContaining({
          status: 'ok',
          component: 'database'
        })
      );
      
      expect(domeMetrics.timing).toHaveBeenCalledWith(
        'test_service.health.check_duration_ms',
        50,
        expect.objectContaining({
          status: 'ok',
          component: 'database'
        })
      );
      
      expect(domeMetrics.gauge).toHaveBeenCalledWith(
        'test_service.health.status',
        2,
        expect.objectContaining({
          status: 'ok',
          component: 'database'
        })
      );
    });

    it('should track a warning health check', () => {
      metrics.trackHealthCheck('warning', 50);
      
      expect(domeMetrics.gauge).toHaveBeenCalledWith(
        'test_service.health.status',
        1,
        expect.objectContaining({
          status: 'warning'
        })
      );
    });

    it('should track an error health check', () => {
      metrics.trackHealthCheck('error', 50);
      
      expect(domeMetrics.gauge).toHaveBeenCalledWith(
        'test_service.health.status',
        0,
        expect.objectContaining({
          status: 'error'
        })
      );
    });
  });

  describe('createMetrics', () => {
    it('should create a metrics service using the static method', () => {
      const metricsInstance = ServiceMetrics.createMetrics('static-service');
      expect(metricsInstance).toBeInstanceOf(ServiceMetrics);
    });

    it('should create a metrics service using the factory function', () => {
      const metricsInstance = createMetrics('factory-service');
      expect(metricsInstance).toBeInstanceOf(ServiceMetrics);
    });
  });
});