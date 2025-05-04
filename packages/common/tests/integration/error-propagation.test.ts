import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServiceErrorHandler } from '../../src/errors/errorUtils';
import { createServiceWrapper } from '../../src/utils/functionWrapper';

// Mock dependencies
vi.mock('@dome/errors', () => ({
  toDomeError: vi.fn((error, message, details) => ({
    message: message || (error instanceof Error ? error.message : 'Unknown error'),
    code: error.code || 'MOCKED_ERROR',
    details: { ...(error.details || {}), ...(details || {}) },
    statusCode: error.statusCode || 500,
  })),
  ValidationError: class ValidationError extends Error {
    code = 'VALIDATION_ERROR';
    statusCode = 400;
    details: Record<string, any>;
    constructor(message: string, details?: Record<string, any>) {
      super(message);
      this.name = 'ValidationError';
      this.details = details || {};
    }
  },
  ServiceError: class ServiceError extends Error {
    code = 'SERVICE_ERROR';
    statusCode = 500;
    details: Record<string, any>;
    constructor(message: string, details?: Record<string, any>) {
      super(message);
      this.name = 'ServiceError';
      this.details = details || {};
    }
  },
}));

vi.mock('@dome/common', () => ({
  withContext: vi.fn((meta, fn) => fn()),
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    })),
  })),
  logError: vi.fn(),
  trackOperation: vi.fn((name, fn, meta) => fn()),
}));

describe('Error Propagation Integration Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should propagate errors across service boundaries with context', async () => {
    // Import the mocked errors
    const { ValidationError, ServiceError } = require('@dome/errors');
    const { logError } = require('@dome/common');

    // Create service-specific error handlers
    const toDomeErrorService1 = createServiceErrorHandler('service1');
    const toDomeErrorService2 = createServiceErrorHandler('service2');
    
    // Create service wrappers
    const wrapService1 = createServiceWrapper('service1');
    const wrapService2 = createServiceWrapper('service2');

    // Simulate a validation error in service1
    const service1Function = async (input: any) => {
      return wrapService1({ operation: 'validateInput', input }, async () => {
        if (!input.id) {
          throw new ValidationError('ID is required', { field: 'id' });
        }
        return { valid: true };
      });
    };

    // Simulate service2 calling service1
    const service2Function = async (input: any) => {
      return wrapService2({ operation: 'processRequest', input }, async () => {
        try {
          const result = await service1Function(input);
          return { success: true, result };
        } catch (error) {
          // Convert error with service2 context
          const enhancedError = toDomeErrorService2(
            error,
            'Error processing request',
            { requestId: 'test-123' }
          );
          throw enhancedError;
        }
      });
    };

    // Test error propagation
    try {
      await service2Function({ name: 'Test' }); // Missing id
      // Should not reach here
      expect(true).toBe(false);
    } catch (error: any) {
      // Verify error has been enhanced with context from both services
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.message).toContain('Error processing request');
      expect(error.details).toHaveProperty('field', 'id');
      expect(error.details).toHaveProperty('service', 'service2');
      expect(error.details).toHaveProperty('requestId', 'test-123');
      
      // Verify error was logged
      expect(logError).toHaveBeenCalled();
    }
  });

  it('should maintain error types when propagating across services', async () => {
    // Import the mocked errors
    const { ValidationError, ServiceError } = require('@dome/errors');
    
    // Create service wrappers
    const wrapService1 = createServiceWrapper('service1');
    const wrapService2 = createServiceWrapper('service2');
    const wrapService3 = createServiceWrapper('service3');

    // Simulate a chain of service calls with different error types
    const service1Function = async (input: any) => {
      return wrapService1({ operation: 'validateInput' }, async () => {
        if (input.type === 'validation') {
          throw new ValidationError('Validation failed', { field: 'type' });
        } else if (input.type === 'service') {
          throw new ServiceError('Service error occurred', { reason: 'test' });
        }
        return { valid: true };
      });
    };

    const service2Function = async (input: any) => {
      return wrapService2({ operation: 'processData' }, async () => {
        return await service1Function(input);
      });
    };

    const service3Function = async (input: any) => {
      return wrapService3({ operation: 'handleRequest' }, async () => {
        return await service2Function(input);
      });
    };

    // Test validation error propagation
    try {
      await service3Function({ type: 'validation' });
      // Should not reach here
      expect(true).toBe(false);
    } catch (error: any) {
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.statusCode).toBe(400);
      expect(error.details).toHaveProperty('field', 'type');
    }

    // Test service error propagation
    try {
      await service3Function({ type: 'service' });
      // Should not reach here
      expect(true).toBe(false);
    } catch (error: any) {
      expect(error.code).toBe('SERVICE_ERROR');
      expect(error.statusCode).toBe(500);
      expect(error.details).toHaveProperty('reason', 'test');
    }
  });
});