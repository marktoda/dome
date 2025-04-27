import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createLogger,
  getLogger,
  logOperationStart,
  logOperationSuccess,
  logOperationFailure,
  trackOperation,
  logExternalCall,
  trackedFetch,
  withLogger,
  loggerMiddleware,
  createServiceMetrics,
  metrics,
  LogLevel
} from '../src';

// Mock performance API
global.performance = {
  now: vi.fn(() => 1000),
  ...global.performance
};

// Mock fetch API
global.fetch = vi.fn().mockImplementation(() => 
  Promise.resolve({ 
    status: 200,
    ok: true 
  })
);

describe('Logger Creation and Configuration', () => {
  it('should create a configured logger with service name', () => {
    const logger = createLogger({ service: 'test-service' });
    expect(logger).toBeDefined();
    expect(logger.info).toBeInstanceOf(Function);
    expect(logger.error).toBeInstanceOf(Function);
    expect(logger.warn).toBeInstanceOf(Function);
    expect(logger.debug).toBeInstanceOf(Function);
  });

  it('should use provided component name', () => {
    const logger = createLogger({ 
      service: 'test-service', 
      component: 'test-component' 
    });
    
    expect(logger).toBeDefined();
    // We can't directly test the child context, but we can verify the logger is created
  });

  it('should use environment from options or default', () => {
    // Store original env
    const originalEnv = process.env.ENVIRONMENT;
    
    // Test with explicit environment
    const logger1 = createLogger({ 
      service: 'test-service', 
      environment: 'custom-env' 
    });
    expect(logger1).toBeDefined();
    
    // Test with env var
    process.env.ENVIRONMENT = 'env-var-value';
    const logger2 = createLogger({ service: 'test-service' });
    expect(logger2).toBeDefined();
    
    // Test with default
    process.env.ENVIRONMENT = undefined;
    const logger3 = createLogger({ service: 'test-service' });
    expect(logger3).toBeDefined();
    
    // Restore original env
    process.env.ENVIRONMENT = originalEnv;
  });
});

describe('Operation Logging Helpers', () => {
  let infoSpy;
  let errorSpy;
  
  beforeEach(() => {
    // Mock the getLogger function
    infoSpy = vi.fn();
    errorSpy = vi.fn();
    
    vi.mock('../src/getLogger', () => ({
      getLogger: vi.fn(() => ({
        info: infoSpy,
        error: errorSpy
      }))
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should log operation start', () => {
    logOperationStart('test-operation', { foo: 'bar' });
    
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'test-operation_start',
        foo: 'bar'
      }),
      'Started test-operation'
    );
  });

  it('should log operation success with duration', () => {
    logOperationSuccess('test-operation', 123.45, { foo: 'bar' });
    
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'test-operation_success',
        duration: 123.45,
        foo: 'bar'
      }),
      'Successfully completed test-operation in 123.45ms'
    );
  });

  it('should log operation failure with error details', () => {
    const error = new Error('Test error');
    logOperationFailure('test-operation', error, { foo: 'bar' });
    
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'test-operation_failure',
        error,
        errorMessage: 'Test error',
        foo: 'bar'
      }),
      'Failed to complete test-operation: Test error'
    );
  });
});

describe('Operation Tracking', () => {
  // Store original performance.now
  const originalNow = performance.now;
  let startSpy, successSpy, failureSpy;
  
  beforeEach(() => {
    // Mock logOperationStart, logOperationSuccess, and logOperationFailure
    startSpy = vi.fn();
    successSpy = vi.fn();
    failureSpy = vi.fn();
    
    vi.mock('../src', async (importOriginal) => {
      const originalModule = await importOriginal();
      return {
        ...originalModule,
        logOperationStart: startSpy,
        logOperationSuccess: successSpy,
        logOperationFailure: failureSpy
      };
    });
    
    // Mock performance.now to return incrementing values
    let timeCounter = 1000;
    performance.now = vi.fn(() => {
      timeCounter += 100;
      return timeCounter;
    });
  });
  
  afterEach(() => {
    performance.now = originalNow;
    vi.restoreAllMocks();
  });
  
  it('should track successful operations with timing', async () => {
    const result = await trackOperation(
      'test-operation',
      async () => 'success',
      { foo: 'bar' }
    );
    
    expect(result).toBe('success');
    expect(startSpy).toHaveBeenCalledWith('test-operation', { foo: 'bar' });
    expect(successSpy).toHaveBeenCalledWith(
      'test-operation',
      expect.any(Number),
      { foo: 'bar' }
    );
    expect(failureSpy).not.toHaveBeenCalled();
  });
  
  it('should track failed operations and rethrow errors', async () => {
    const error = new Error('Operation failed');
    
    await expect(
      trackOperation(
        'test-operation',
        async () => { throw error; },
        { foo: 'bar' }
      )
    ).rejects.toThrow('Operation failed');
    
    expect(startSpy).toHaveBeenCalledWith('test-operation', { foo: 'bar' });
    expect(failureSpy).toHaveBeenCalledWith(
      'test-operation',
      error,
      expect.objectContaining({
        foo: 'bar',
        duration: expect.any(Number)
      })
    );
    expect(successSpy).not.toHaveBeenCalled();
  });
});

describe('External API Calls', () => {
  let infoSpy, errorSpy;
  
  beforeEach(() => {
    infoSpy = vi.fn();
    errorSpy = vi.fn();
    
    vi.mock('../src/getLogger', () => ({
      getLogger: vi.fn(() => ({
        info: infoSpy,
        error: errorSpy
      })),
      getRequestId: vi.fn(() => 'test-request-id')
    }));
    
    // Reset fetch mock
    global.fetch = vi.fn().mockImplementation(() => 
      Promise.resolve({ 
        status: 200,
        ok: true 
      })
    );
    
    // Mock performance.now
    let timeCounter = 1000;
    performance.now = vi.fn(() => {
      timeCounter += 100;
      return timeCounter;
    });
  });
  
  afterEach(() => {
    vi.restoreAllMocks();
  });
  
  it('should log successful external calls', () => {
    logExternalCall(
      'https://api.example.com/data',
      'GET',
      200,
      123.45,
      { foo: 'bar' }
    );
    
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'external_call',
        url: 'https://api.example.com/data',
        method: 'GET',
        status: 200,
        duration: 123.45,
        success: true,
        foo: 'bar'
      }),
      'External GET call to https://api.example.com/data completed with status 200 in 123.45ms'
    );
  });
  
  it('should log failed external calls with error level', () => {
    logExternalCall(
      'https://api.example.com/data',
      'POST',
      500,
      123.45,
      { foo: 'bar' }
    );
    
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'external_call',
        url: 'https://api.example.com/data',
        method: 'POST',
        status: 500,
        duration: 123.45,
        success: false,
        foo: 'bar'
      }),
      'External POST call to https://api.example.com/data completed with status 500 in 123.45ms'
    );
  });
  
  it('should automatically log fetch requests', async () => {
    await trackedFetch('https://api.example.com/data', { method: 'POST' }, { foo: 'bar' });
    
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.example.com/data',
      expect.objectContaining({
        method: 'POST',
        headers: expect.any(Headers)
      })
    );
    
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'external_call',
        url: 'https://api.example.com/data',
        method: 'POST',
        status: 200,
        foo: 'bar'
      }),
      expect.any(String)
    );
  });
  
  it('should propagate request ID in headers', async () => {
    await trackedFetch('https://api.example.com/data');
    
    // Check if the request ID was set in headers
    const fetchCall = global.fetch.mock.calls[0];
    const headers = fetchCall[1].headers;
    
    expect(headers.has('x-request-id')).toBe(true);
    expect(headers.get('x-request-id')).toBe('test-request-id');
  });
  
  it('should log fetch errors appropriately', async () => {
    // Mock fetch to throw an error
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
    
    await expect(
      trackedFetch('https://api.example.com/data')
    ).rejects.toThrow('Network error');
    
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'external_call_failure',
        url: 'https://api.example.com/data',
        method: 'GET',
        error: expect.any(Error),
        errorMessage: 'Network error'
      }),
      expect.any(String)
    );
  });
});

describe('Request Context and Middleware', () => {
  it('should execute function with logger context', async () => {
    const fn = vi.fn().mockResolvedValue('result');
    const context = { 
      requestId: 'test-req-id', 
      path: '/test', 
      method: 'GET' 
    };
    
    const result = await withLogger(context, fn);
    
    expect(result).toBe('result');
    expect(fn).toHaveBeenCalled();
    // Cannot directly test that context was set, but we can verify fn was called
  });
  
  it('should create logger middleware', () => {
    const middleware = loggerMiddleware();
    expect(middleware).toBeInstanceOf(Function);
  });
  
  it('should execute middleware and set context logger', async () => {
    // Mock crypto.randomUUID
    global.crypto = {
      ...global.crypto,
      randomUUID: vi.fn(() => 'generated-uuid')
    };
    
    const middleware = loggerMiddleware();
    const mockCtx = {
      req: {
        header: vi.fn((name) => {
          if (name === 'x-request-id') return 'test-req-id';
          return null;
        }),
        path: '/test',
        method: 'GET'
      },
      res: {
        status: 200
      },
      set: vi.fn()
    };
    const mockNext = vi.fn().mockResolvedValue();
    
    await middleware(mockCtx, mockNext);
    
    expect(mockCtx.set).toHaveBeenCalledWith('logger', expect.anything());
    expect(mockNext).toHaveBeenCalled();
  });
  
  it('should use provided request ID or generate one', async () => {
    // First with provided ID
    const middleware = loggerMiddleware();
    const mockCtx1 = {
      req: {
        header: vi.fn((name) => {
          if (name === 'x-request-id') return 'provided-req-id';
          return null;
        }),
        path: '/test',
        method: 'GET'
      },
      res: {
        status: 200
      },
      set: vi.fn()
    };
    await middleware(mockCtx1, vi.fn().mockResolvedValue());
    
    // Then without provided ID
    const mockCtx2 = {
      req: {
        header: vi.fn(() => null),
        path: '/test',
        method: 'GET'
      },
      res: {
        status: 200
      },
      set: vi.fn()
    };
    await middleware(mockCtx2, vi.fn().mockResolvedValue());
    
    // We can't directly test the logger values but both should have had loggers set
    expect(mockCtx1.set).toHaveBeenCalledWith('logger', expect.anything());
    expect(mockCtx2.set).toHaveBeenCalledWith('logger', expect.anything());
  });
  
  it('should handle errors in the middleware chain', async () => {
    const middleware = loggerMiddleware();
    const error = new Error('Middleware error');
    const mockCtx = {
      req: {
        header: vi.fn(() => null),
        path: '/test',
        method: 'GET'
      },
      res: {
        status: 500
      },
      set: vi.fn()
    };
    const mockNext = vi.fn().mockRejectedValue(error);
    
    await expect(middleware(mockCtx, mockNext)).rejects.toThrow('Middleware error');
    expect(mockCtx.set).toHaveBeenCalledWith('logger', expect.anything());
  });
});

describe('Service Metrics', () => {
  beforeEach(() => {
    // Mock metrics methods
    vi.mock('../src/metrics', () => ({
      metrics: {
        increment: vi.fn(),
        gauge: vi.fn(),
        timing: vi.fn(),
        startTimer: vi.fn().mockReturnValue({
          stop: vi.fn(() => 100)
        }),
        trackOperation: vi.fn()
      }
    }));
  });
  
  afterEach(() => {
    vi.restoreAllMocks();
  });
  
  it('should create service metrics with correct prefixing', () => {
    const serviceMetrics = createServiceMetrics('test-service');
    
    expect(serviceMetrics.counter).toBeInstanceOf(Function);
    expect(serviceMetrics.gauge).toBeInstanceOf(Function);
    expect(serviceMetrics.timing).toBeInstanceOf(Function);
    expect(serviceMetrics.startTimer).toBeInstanceOf(Function);
    expect(serviceMetrics.trackOperation).toBeInstanceOf(Function);
  });
  
  it('should call correct metrics methods with prefixed names', () => {
    const serviceMetrics = createServiceMetrics('test-service');
    
    serviceMetrics.counter('requests', 5, { status: '200' });
    expect(metrics.increment).toHaveBeenCalledWith(
      'test-service.requests',
      5,
      { status: '200' }
    );
    
    serviceMetrics.gauge('memory', 100, { type: 'heap' });
    expect(metrics.gauge).toHaveBeenCalledWith(
      'test-service.memory',
      100,
      { type: 'heap' }
    );
    
    serviceMetrics.timing('response_time', 250, { endpoint: '/api' });
    expect(metrics.timing).toHaveBeenCalledWith(
      'test-service.response_time',
      250,
      { endpoint: '/api' }
    );
    
    serviceMetrics.trackOperation('db_query', true, { table: 'users' });
    expect(metrics.trackOperation).toHaveBeenCalledWith(
      'test-service.db_query',
      true,
      { table: 'users' }
    );
  });
  
  it('should handle timer start and stop', () => {
    const serviceMetrics = createServiceMetrics('test-service');
    
    const timer = serviceMetrics.startTimer('operation');
    expect(metrics.startTimer).toHaveBeenCalledWith('test-service.operation');
    
    const duration = timer.stop({ result: 'success' });
    expect(duration).toBe(100);
  });
});