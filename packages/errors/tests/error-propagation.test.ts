import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Context } from 'hono';
import {
  DomeError,
  ValidationError,
  NotFoundError,
  errorHandler,
  toDomeError
} from '../src';

// Mock Hono Response
class MockResponse {
  status = 200;
  headers = new Map();
  body = null;

  constructor() {
    this.status = 200;
    this.headers = new Map();
    this.body = null;
  }
}

describe('Error Propagation Across Service Boundaries', () => {
  // Mock services
  const upstreamService = {
    async callDownstreamService(requestId: string) {
      // Simulate calling another service
      return await downstreamService.performOperation(requestId);
    }
  };

  const downstreamService = {
    async performOperation(requestId: string, shouldFail = false) {
      if (shouldFail) {
        throw new NotFoundError('Resource not found in downstream service', { requestId });
      }
      return { success: true, requestId };
    }
  };

  // Spy on service methods
  beforeEach(() => {
    vi.spyOn(upstreamService, 'callDownstreamService');
    vi.spyOn(downstreamService, 'performOperation');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should propagate request ID through service calls', async () => {
    const requestId = 'test-request-id-123';
    const result = await upstreamService.callDownstreamService(requestId);
    
    expect(result).toEqual({ success: true, requestId: 'test-request-id-123' });
    expect(downstreamService.performOperation).toHaveBeenCalledWith(requestId);
  });

  it('should preserve error context when propagating errors', async () => {
    const requestId = 'test-request-id-456';
    
    // Mock downstream service to throw an error
    downstreamService.performOperation = vi.fn().mockImplementation((reqId) => {
      throw new NotFoundError('Resource not found in downstream service', { requestId: reqId });
    });
    
    try {
      await upstreamService.callDownstreamService(requestId);
      // Should not reach here
      expect(true).toBe(false);
    } catch (error) {
      // Verify the error is propagated correctly
      expect(error).toBeInstanceOf(NotFoundError);
      expect(error.message).toBe('Resource not found in downstream service');
      expect(error.details).toEqual({ requestId: 'test-request-id-456' });
    }
  });

  it('should enrich errors with additional context when re-throwing', async () => {
    const requestId = 'test-request-id-789';
    
    // Mock upstream service to catch and enrich errors
    upstreamService.callDownstreamService = vi.fn().mockImplementation(async (reqId) => {
      try {
        return await downstreamService.performOperation(reqId, true);
      } catch (error) {
        // Enrich the error with additional context
        if (error instanceof DomeError) {
          error.withContext({ 
            service: 'upstream',
            operation: 'callDownstreamService',
            timestamp: expect.any(String)
          });
        }
        throw error;
      }
    });
    
    try {
      await upstreamService.callDownstreamService(requestId);
      // Should not reach here
      expect(true).toBe(false);
    } catch (error) {
      // Verify error is enriched while preserving original data
      expect(error).toBeInstanceOf(NotFoundError);
      expect(error.details).toEqual({
        requestId: 'test-request-id-789',
        service: 'upstream',
        operation: 'callDownstreamService',
        timestamp: expect.any(String)
      });
    }
  });
});

describe('End-to-End Error Handling', () => {
  // Mock request creator
  function createMockContext(requestId?: string): any {
    return {
      req: {
        path: '/test/api',
        method: 'GET',
        header: (name: string) => name === 'x-request-id' ? requestId : null
      },
      res: new MockResponse(),
      set: vi.fn(),
      get: vi.fn().mockImplementation((key) => {
        if (key === 'logger') {
          return { error: vi.fn() };
        }
        return undefined;
      }),
      status: function(code: number) {
        this.res.status = code;
        return this;
      },
      json: function(data: any) {
        this.res.body = data;
        return this;
      }
    };
  }

  // Mock service with error middleware
  async function runServiceWithMiddleware(
    context: any,
    operation: () => Promise<any>,
    options = {}
  ) {
    const handler = errorHandler(options);
    
    try {
      await handler(context, async () => {
        return await operation();
      });
    } catch (error) {
      // This should not happen as errorHandler should catch all errors
      console.error('Unexpected error escaped middleware:', error);
      throw error;
    }
    
    return {
      status: context.res.status,
      body: context.res.body
    };
  }

  it('should handle errors with request ID propagation', async () => {
    const requestId = 'end-to-end-req-id-123';
    const mockCtx = createMockContext(requestId);
    
    const operation = async () => {
      throw new ValidationError('Invalid input data', { requestId });
    };
    
    const response = await runServiceWithMiddleware(mockCtx, operation);
    
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid input data',
        details: { requestId }
      }
    });
  });

  it('should convert and standardize errors across multiple services', async () => {
    const requestId = 'end-to-end-req-id-456';
    const mockCtx = createMockContext(requestId);
    
    // Simulate multiple service hops with error conversion
    const operation = async () => {
      try {
        await simulateServiceCall(3, requestId);
      } catch (error) {
        // Convert error while preserving context
        throw toDomeError(error, 'Error in API Gateway', { layer: 'api-gateway' });
      }
    };
    
    const response = await runServiceWithMiddleware(mockCtx, operation);
    
    expect(response.status).toBe(500);
    expect(response.body.error.details).toEqual(
      expect.objectContaining({
        requestId,
        layer: 'api-gateway',
        serviceHop: 3
      })
    );
  });

  it('should include request context in errors', async () => {
    const requestId = 'end-to-end-req-id-789';
    const mockCtx = createMockContext(requestId);
    
    // Custom error mapping to include request context
    const errorMapper = (err: unknown) => {
      const domeError = toDomeError(err);
      // Add request context
      domeError.withContext({
        path: mockCtx.req.path,
        method: mockCtx.req.method,
        requestId
      });
      return domeError;
    };
    
    const operation = async () => {
      throw new Error('Generic error');
    };
    
    const response = await runServiceWithMiddleware(mockCtx, operation, { errorMapper });
    
    expect(response.status).toBe(500);
    expect(response.body.error.details).toEqual({
      path: '/test/api',
      method: 'GET',
      requestId: 'end-to-end-req-id-789'
    });
  });
});

// Helper function to simulate service call chain
async function simulateServiceCall(depth: number, requestId: string) {
  if (depth <= 0) {
    return { success: true };
  }
  
  try {
    return await simulateServiceCall(depth - 1, requestId);
  } catch (error) {
    // Add context at each service level
    if (error instanceof DomeError) {
      error.withContext({ 
        serviceHop: depth,
        requestId 
      });
    } else {
      throw new DomeError('Service error', {
        code: 'SERVICE_ERROR',
        statusCode: 500,
        details: { 
          serviceHop: depth,
          requestId,
          originalError: error instanceof Error ? error.message : String(error)
        }
      });
    }
    throw error;
  }
  
  // Simulate error at the deepest level
  if (depth === 1) {
    throw new DomeError('Deep service error', {
      code: 'DEEP_SERVICE_ERROR',
      statusCode: 500,
      details: { 
        serviceHop: depth,
        requestId 
      }
    });
  }
}