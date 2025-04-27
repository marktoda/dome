import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Context, Next } from 'hono';
import {
  loggerMiddleware,
  createLogger,
  trackedFetch,
  logExternalCall,
  trackOperation
} from '../src';

// Mock fetch and performance APIs
global.fetch = vi.fn();
global.performance = {
  now: vi.fn(),
  ...global.performance
};

// Create mock implementations
let mockPerformanceTime = 1000;
performance.now = vi.fn(() => {
  const currentTime = mockPerformanceTime;
  mockPerformanceTime += 100;
  return currentTime;
});

describe('Middleware Integration and Request Context Propagation', () => {
  let mockContext: any;
  let mockNext: Next;
  let mockLogger: Record<string, any>;
  
  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis()
    };
    
    mockContext = {
      req: {
        path: '/test/endpoint',
        method: 'GET',
        header: vi.fn((name) => name === 'x-request-id' ? 'test-req-id-123' : null)
      },
      res: {
        status: 200
      },
      set: vi.fn(),
      get: vi.fn((key) => key === 'logger' ? mockLogger : undefined)
    };
    
    mockNext = vi.fn().mockResolvedValue(undefined);
    
    // Reset fetch mock
    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true
    });
  });
  
  afterEach(() => {
    vi.resetAllMocks();
  });
  
  it('should add logger to context with request info', async () => {
    const middleware = loggerMiddleware();
    await middleware(mockContext as Context, mockNext);
    
    expect(mockContext.set).toHaveBeenCalledWith('logger', expect.anything());
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'request_start' })
    );
    expect(mockNext).toHaveBeenCalled();
  });
  
  it('should log request completion with timing', async () => {
    const middleware = loggerMiddleware();
    await middleware(mockContext as Context, mockNext);
    
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'request_end',
        duration: expect.any(Number),
        status: 200
      })
    );
  });
  
  it('should log and rethrow errors', async () => {
    const error = new Error('Test error');
    mockNext.mockRejectedValue(error);
    
    const middleware = loggerMiddleware();
    await expect(middleware(mockContext as Context, mockNext)).rejects.toThrow('Test error');
    
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'request_error',
        error,
        errorMessage: expect.any(String)
      })
    );
  });
  
  it('should propagate request ID to downstream services', async () => {
    // Setup the middleware to set the logger in context
    const middleware = loggerMiddleware();
    await middleware(mockContext as Context, mockNext);
    
    // Now use trackedFetch which should extract request ID from context
    await trackedFetch('https://api.example.com/data');
    
    // Check if request ID was propagated
    const fetchCall = global.fetch.mock.calls[0];
    const headers = fetchCall[1].headers;
    
    expect(headers.has('x-request-id')).toBe(true);
    expect(headers.get('x-request-id')).toBe('test-req-id-123');
  });
  
  it('should propagate request ID through multiple layers of operations', async () => {
    // Setup the middleware to set the logger in context
    const middleware = loggerMiddleware();
    await middleware(mockContext as Context, mockNext);
    
    // Create nested operations that should maintain the request context
    await trackOperation('parent-operation', async () => {
      // First level operation
      await trackOperation('child-operation', async () => {
        // Second level operation
        await trackedFetch('https://api.example.com/nested');
      });
    });
    
    // Check all logged operations have the request ID
    const fetchCall = global.fetch.mock.calls[0];
    const headers = fetchCall[1].headers;
    
    expect(headers.has('x-request-id')).toBe(true);
    expect(headers.get('x-request-id')).toBe('test-req-id-123');
    
    // Verify logging happened with correct context
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'parent-operation_start'
      }),
      expect.any(String)
    );
    
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'child-operation_start'
      }),
      expect.any(String)
    );
  });
});

describe('Cross-Service Request Tracing', () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({
        'x-request-id': 'propagated-req-id-456'
      })
    });
  });
  
  afterEach(() => {
    vi.resetAllMocks();
  });
  
  it('should simulate complete request flow across multiple services', async () => {
    // Simulate API Gateway
    const apiGatewayHandler = async (requestId: string) => {
      const logger = createLogger({ service: 'api-gateway' }).child({ requestId });
      
      return await trackOperation('process_request', async () => {
        logger.info({ event: 'routing_request', destination: 'service-a' });
        return await callServiceA(requestId);
      }, { requestId });
    };
    
    // Simulate Service A
    async function callServiceA(requestId: string) {
      const logger = createLogger({ service: 'service-a' }).child({ requestId });
      
      return await trackOperation('process_service_a', async () => {
        logger.info({ event: 'processing_in_service_a' });
        
        // Call Service B via fetch
        const response = await trackedFetch(
          'https://service-b.example.com/api',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-request-id': requestId
            },
            body: JSON.stringify({ data: 'test' })
          },
          { service: 'service-a', operation: 'call_service_b', requestId }
        );
        
        return { status: 'success', origin: 'service-a', data: 'processed' };
      }, { requestId });
    }
    
    // Run the simulated request flow
    const result = await apiGatewayHandler('original-req-id-789');
    
    // Verify request ID propagation
    const fetchCall = global.fetch.mock.calls[0];
    const headers = fetchCall[1].headers;
    
    expect(headers.get('x-request-id')).toBe('original-req-id-789');
    expect(result).toEqual({
      status: 'success',
      origin: 'service-a',
      data: 'processed'
    });
  });
  
  it('should handle errors with proper context in cross-service calls', async () => {
    // Make fetch throw an error to simulate downstream service failure
    global.fetch = vi.fn().mockRejectedValue(new Error('Service B unavailable'));
    
    // Simulate cross-service call
    const makeServiceCall = async (requestId: string) => {
      const logger = createLogger({ service: 'caller-service' }).child({ requestId });
      
      try {
        await trackedFetch(
          'https://downstream.example.com/api',
          {
            method: 'GET',
            headers: {
              'x-request-id': requestId
            }
          },
          { operation: 'fetch_data', requestId }
        );
      } catch (error) {
        // Log the error with proper context
        logger.error({
          event: 'downstream_service_error',
          error,
          errorType: error instanceof Error ? error.constructor.name : typeof error,
          requestId
        });
        
        // Rethrow with context
        throw error;
      }
    };
    
    // Check error propagation
    await expect(makeServiceCall('error-req-id-999')).rejects.toThrow('Service B unavailable');
    
    // Verify request ID was sent in headers even though request failed
    const fetchCall = global.fetch.mock.calls[0];
    const headers = fetchCall[1].headers;
    expect(headers.get('x-request-id')).toBe('error-req-id-999');
  });
});