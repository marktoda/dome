import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createServiceErrorHandler,
  createEnhancedAssertValid,
  createServiceErrorMiddleware,
} from '../../src/errors/errorUtils';

// Mock dependencies
vi.mock('@dome/errors', () => ({
  toDomeError: vi.fn((error, message, details) => ({
    message: message || (error instanceof Error ? error.message : 'Unknown error'),
    code: 'MOCKED_ERROR',
    details: details || {},
    statusCode: 500,
  })),
  assertValid: vi.fn((condition, message, details) => {
    if (!condition) {
      throw {
        message,
        code: 'VALIDATION_ERROR',
        details: details || {},
        statusCode: 400,
      };
    }
  }),
}));

vi.mock('@dome/common', () => ({
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
}));

describe('Error Utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createServiceErrorHandler', () => {
    it('should create a service-specific error handler', () => {
      const toDomeError = createServiceErrorHandler('test-service');
      expect(typeof toDomeError).toBe('function');
    });

    it('should add service name to error details', () => {
      const toDomeError = createServiceErrorHandler('test-service');
      const error = new Error('Test error');
      const result = toDomeError(error);

      expect(result).toHaveProperty('details.service', 'test-service');
    });

    it('should use default message with service name if not provided', () => {
      const toDomeError = createServiceErrorHandler('test-service');
      const error = new Error('Test error');
      const result = toDomeError(error);

      expect(result.message).toContain('test-service');
    });

    it('should merge additional details with service name', () => {
      const toDomeError = createServiceErrorHandler('test-service');
      const error = new Error('Test error');
      const result = toDomeError(error, 'Custom message', { operation: 'test-op' });

      expect(result.details).toHaveProperty('service', 'test-service');
      expect(result.details).toHaveProperty('operation', 'test-op');
    });
  });

  describe('createEnhancedAssertValid', () => {
    it('should create an enhanced assert function', () => {
      const assertValid = createEnhancedAssertValid();
      expect(typeof assertValid).toBe('function');
    });

    it('should pass validation for true boolean', () => {
      const assertValid = createEnhancedAssertValid();
      expect(() => assertValid(true, 'Should not throw')).not.toThrow();
    });

    it('should fail validation for false boolean', () => {
      const assertValid = createEnhancedAssertValid();
      expect(() => assertValid(false, 'Should throw')).toThrow();
    });

    it('should pass validation for non-empty string', () => {
      const assertValid = createEnhancedAssertValid();
      expect(() => assertValid('test', 'Should not throw')).not.toThrow();
    });

    it('should fail validation for empty string', () => {
      const assertValid = createEnhancedAssertValid();
      expect(() => assertValid('', 'Should throw')).toThrow();
    });

    it('should fail validation for null', () => {
      const assertValid = createEnhancedAssertValid();
      expect(() => assertValid(null, 'Should throw')).toThrow();
    });

    it('should fail validation for undefined', () => {
      const assertValid = createEnhancedAssertValid();
      expect(() => assertValid(undefined, 'Should throw')).toThrow();
    });

    it('should include details in error when validation fails', () => {
      const { assertValid: originalAssertValid } = require('@dome/errors');
      const assertValid = createEnhancedAssertValid();

      assertValid(false, 'Validation failed', { field: 'test' });

      expect(originalAssertValid).toHaveBeenCalledWith(false, 'Validation failed', {
        field: 'test',
      });
    });
  });

  describe('createServiceErrorMiddleware', () => {
    it('should create a service-specific error middleware', () => {
      const createErrorMiddleware = createServiceErrorMiddleware('test-service');
      expect(typeof createErrorMiddleware).toBe('function');
    });

    it('should handle errors and return appropriate response', async () => {
      const createErrorMiddleware = createServiceErrorMiddleware('test-service');
      const middleware = createErrorMiddleware();

      const mockContext = {
        status: vi.fn(),
        json: vi.fn().mockReturnValue('json-response'),
        req: {
          path: '/test',
          method: 'GET',
        },
      };

      const mockNext = vi.fn().mockRejectedValue(new Error('Test error'));

      const result = await middleware(mockContext, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockContext.status).toHaveBeenCalledWith(500);
      expect(mockContext.json).toHaveBeenCalledWith({
        success: false,
        error: expect.objectContaining({
          code: 'MOCKED_ERROR',
          message: expect.any(String),
          details: expect.any(Object),
        }),
      });
      expect(result).toBe('json-response');
    });

    it('should use custom error mapper if provided', async () => {
      const errorMapper = vi.fn().mockReturnValue({
        code: 'CUSTOM_ERROR',
        message: 'Custom error message',
        details: { custom: true },
        statusCode: 418,
      });

      const createErrorMiddleware = createServiceErrorMiddleware('test-service');
      const middleware = createErrorMiddleware({ errorMapper });

      const mockContext = {
        status: vi.fn(),
        json: vi.fn().mockReturnValue('json-response'),
        req: {
          path: '/test',
          method: 'GET',
        },
      };

      const mockNext = vi.fn().mockRejectedValue(new Error('Test error'));

      await middleware(mockContext, mockNext);

      expect(errorMapper).toHaveBeenCalledWith(expect.any(Error));
      expect(mockContext.status).toHaveBeenCalledWith(418);
      expect(mockContext.json).toHaveBeenCalledWith({
        success: false,
        error: {
          code: 'CUSTOM_ERROR',
          message: 'Custom error message',
          details: { custom: true },
        },
      });
    });
  });
});
