import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DomeError,
  ValidationError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  BadRequestError,
  InternalError,
  ServiceUnavailableError,
  RateLimitError,
  ConflictError,
  toDomeError,
  createErrorWrapper,
  assertValid,
  assertExists,
  handleDatabaseError,
  createErrorFactory,
  errorHandler
} from '../src';

describe('DomeError Base Class', () => {
  it('should create a basic error with default statusCode', () => {
    const error = new DomeError('Test error', { code: 'TEST_ERROR' });
    expect(error.message).toBe('Test error');
    expect(error.code).toBe('TEST_ERROR');
    expect(error.statusCode).toBe(500); // Default status code
    expect(error.details).toBeUndefined();
    expect(error.cause).toBeUndefined();
  });

  it('should create an error with all properties', () => {
    const cause = new Error('Original error');
    const details = { foo: 'bar' };
    const error = new DomeError('Test error', { 
      code: 'TEST_ERROR', 
      statusCode: 418, 
      details, 
      cause 
    });
    
    expect(error.message).toBe('Test error');
    expect(error.code).toBe('TEST_ERROR');
    expect(error.statusCode).toBe(418);
    expect(error.details).toBe(details);
    expect(error.cause).toBe(cause);
  });

  it('should convert to JSON with stack trace in non-production', () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    
    const error = new DomeError('Test error', { code: 'TEST_ERROR' });
    const json = error.toJSON();
    
    expect(json.name).toBe('DomeError');
    expect(json.message).toBe('Test error');
    expect(json.code).toBe('TEST_ERROR');
    expect(json.stack).toBeDefined();
    
    process.env.NODE_ENV = originalEnv;
  });

  it('should hide stack trace in production', () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    
    const error = new DomeError('Test error', { code: 'TEST_ERROR' });
    const json = error.toJSON();
    
    expect(json.stack).toBeUndefined();
    
    process.env.NODE_ENV = originalEnv;
  });

  it('should convert to API response format', () => {
    const details = { foo: 'bar' };
    const error = new DomeError('Test error', { code: 'TEST_ERROR', details });
    const response = error.toApiResponse();
    
    expect(response).toEqual({
      error: {
        code: 'TEST_ERROR',
        message: 'Test error',
        details: { foo: 'bar' }
      }
    });
  });

  it('should allow adding context with withContext method', () => {
    const error = new DomeError('Test error', { code: 'TEST_ERROR' });
    error.withContext({ foo: 'bar' });
    expect(error.details).toEqual({ foo: 'bar' });
    
    // Add more context
    error.withContext({ baz: 'qux' });
    expect(error.details).toEqual({ foo: 'bar', baz: 'qux' });
  });
});

describe('Error Subclasses', () => {
  it('should create ValidationError with correct defaults', () => {
    const error = new ValidationError('Invalid input');
    expect(error.message).toBe('Invalid input');
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.statusCode).toBe(400);
  });

  it('should create NotFoundError with correct defaults', () => {
    const error = new NotFoundError('Resource not found');
    expect(error.message).toBe('Resource not found');
    expect(error.code).toBe('NOT_FOUND');
    expect(error.statusCode).toBe(404);
  });

  it('should create UnauthorizedError with correct defaults', () => {
    const error = new UnauthorizedError('Not authenticated');
    expect(error.message).toBe('Not authenticated');
    expect(error.code).toBe('UNAUTHORIZED');
    expect(error.statusCode).toBe(401);
  });

  it('should create ForbiddenError with correct defaults', () => {
    const error = new ForbiddenError('Not authorized');
    expect(error.message).toBe('Not authorized');
    expect(error.code).toBe('FORBIDDEN');
    expect(error.statusCode).toBe(403);
  });

  it('should create BadRequestError with correct defaults', () => {
    const error = new BadRequestError('Bad request');
    expect(error.message).toBe('Bad request');
    expect(error.code).toBe('BAD_REQUEST');
    expect(error.statusCode).toBe(400);
  });

  it('should create InternalError with correct defaults', () => {
    const error = new InternalError('Server error');
    expect(error.message).toBe('Server error');
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.statusCode).toBe(500);
  });

  it('should create ServiceUnavailableError with correct defaults', () => {
    const error = new ServiceUnavailableError('Service down');
    expect(error.message).toBe('Service down');
    expect(error.code).toBe('SERVICE_UNAVAILABLE');
    expect(error.statusCode).toBe(503);
  });

  it('should create RateLimitError with correct defaults', () => {
    const error = new RateLimitError('Too many requests');
    expect(error.message).toBe('Too many requests');
    expect(error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(error.statusCode).toBe(429);
  });

  it('should create ConflictError with correct defaults', () => {
    const error = new ConflictError('Resource conflict');
    expect(error.message).toBe('Resource conflict');
    expect(error.code).toBe('CONFLICT');
    expect(error.statusCode).toBe(409);
  });
});

describe('toDomeError Utility', () => {
  it('should pass through a DomeError', () => {
    const original = new ValidationError('Original error');
    const converted = toDomeError(original);
    expect(converted).toBe(original);
  });

  it('should convert standard Error to InternalError', () => {
    const original = new Error('Standard error');
    const converted = toDomeError(original);
    expect(converted).toBeInstanceOf(InternalError);
    expect(converted.message).toBe('Standard error');
    expect(converted.cause).toBe(original);
  });

  it('should detect status code in error message', () => {
    const notFoundErr = new Error('404 Resource not found');
    const converted = toDomeError(notFoundErr);
    expect(converted).toBeInstanceOf(NotFoundError);
  });

  it('should convert string to InternalError', () => {
    const converted = toDomeError('String error');
    expect(converted).toBeInstanceOf(InternalError);
    expect(converted.message).toBe('String error');
  });

  it('should convert object to InternalError', () => {
    const obj = { message: 'Object error', details: { foo: 'bar' } };
    const converted = toDomeError(obj);
    expect(converted).toBeInstanceOf(InternalError);
    expect(converted.message).toBe('Object error');
    expect(converted.details).toEqual({ foo: 'bar' });
  });

  it('should handle null/undefined with default message', () => {
    const converted = toDomeError(null);
    expect(converted).toBeInstanceOf(InternalError);
    expect(converted.message).toBe('An unexpected error occurred');
  });
});

describe('Error Wrapping Utilities', () => {
  it('should wrap function with error handling', async () => {
    const wrapWithError = createErrorWrapper('Operation failed');
    
    // Success case
    const successFn = async () => 'success';
    const result = await wrapWithError(successFn);
    expect(result).toBe('success');
    
    // Error case
    const errorFn = async () => { throw new Error('Original error'); };
    await expect(wrapWithError(errorFn)).rejects.toBeInstanceOf(InternalError);
    
    try {
      await wrapWithError(errorFn);
    } catch (error) {
      expect(error.message).toBe('Original error'); // Preserves original message
      expect(error.cause).toBeInstanceOf(Error);
      expect(error.cause.message).toBe('Original error');
    }
  });

  it('should allow custom message and details in wrapper', async () => {
    const wrapWithError = createErrorWrapper('Default message');
    const errorFn = async () => { throw new Error('Original error'); };
    
    try {
      await wrapWithError(errorFn, 'Custom message', { operation: 'test' });
    } catch (error) {
      expect(error.message).toBe('Original error'); // Preserves original message
      expect(error.details).toEqual({ operation: 'test' });
    }
  });
});

describe('Assertion Utilities', () => {
  it('should not throw when assertion is valid', () => {
    expect(() => assertValid(true, 'Should not throw')).not.toThrow();
  });

  it('should throw ValidationError when assertion fails', () => {
    expect(() => assertValid(false, 'Invalid input')).toThrow(ValidationError);
    expect(() => assertValid(false, 'Invalid input')).toThrow('Invalid input');
  });

  it('should pass through non-null values in assertExists', () => {
    expect(assertExists('value', 'Should not throw')).toBe('value');
    expect(assertExists(0, 'Should not throw')).toBe(0);
    expect(assertExists(false, 'Should not throw')).toBe(false);
  });

  it('should throw NotFoundError for null/undefined in assertExists', () => {
    expect(() => assertExists(null, 'Not found')).toThrow(NotFoundError);
    expect(() => assertExists(undefined, 'Not found')).toThrow('Not found');
  });
});

describe('Database Error Handling', () => {
  it('should convert P2025 to NotFoundError', () => {
    const dbError = { code: 'P2025', message: 'Record not found' };
    const error = handleDatabaseError(dbError, 'find user');
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.message).toContain('Resource not found');
    expect(error.message).toContain('find user');
  });

  it('should convert P2002 to ConflictError', () => {
    const dbError = { code: 'P2002', message: 'Unique constraint violation' };
    const error = handleDatabaseError(dbError, 'create user');
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.message).toContain('Duplicate entry');
    expect(error.message).toContain('create user');
  });

  it('should convert P2003 to ValidationError', () => {
    const dbError = { code: 'P2003', message: 'Foreign key constraint violation' };
    const error = handleDatabaseError(dbError, 'create post');
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toContain('Foreign key constraint');
    expect(error.message).toContain('create post');
  });

  it('should convert unknown DB errors to InternalError', () => {
    const dbError = { code: 'UNKNOWN', message: 'Database connection lost' };
    const error = handleDatabaseError(dbError, 'query database');
    expect(error).toBeInstanceOf(InternalError);
    expect(error.message).toContain('Database error');
    expect(error.message).toContain('query database');
  });

  it('should include details in converted errors', () => {
    const dbError = { code: 'P2025', message: 'Record not found' };
    const details = { userId: '123', operation: 'fetch' };
    const error = handleDatabaseError(dbError, 'find user', details);
    expect(error.details).toEqual(details);
  });
});

describe('Error Factory', () => {
  it('should create domain-prefixed errors', () => {
    const userErrors = createErrorFactory('UserService');
    
    const validationError = userErrors.validation('Invalid email');
    expect(validationError).toBeInstanceOf(ValidationError);
    expect(validationError.message).toBe('[UserService] Invalid email');
    
    const notFoundError = userErrors.notFound('User not found');
    expect(notFoundError).toBeInstanceOf(NotFoundError);
    expect(notFoundError.message).toBe('[UserService] User not found');
  });

  it('should include default details in all errors', () => {
    const authErrors = createErrorFactory('AuthService', { service: 'auth' });
    
    const unauthorizedError = authErrors.unauthorized('Invalid token');
    expect(unauthorizedError).toBeInstanceOf(UnauthorizedError);
    expect(unauthorizedError.details).toEqual({ service: 'auth' });
    
    // Should merge with provided details
    const forbiddenError = authErrors.forbidden('Access denied', { resource: 'admin' });
    expect(forbiddenError.details).toEqual({ service: 'auth', resource: 'admin' });
  });
});

describe('Error Handler Middleware', () => {
  let mockContext;
  let mockNext;
  
  beforeEach(() => {
    // Setup mock context
    mockContext = {
      req: {
        path: '/test',
        method: 'GET'
      },
      res: {
        status: vi.fn().mockReturnThis(),
      },
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      get: vi.fn().mockImplementation((key) => {
        if (key === 'logger') {
          return { error: vi.fn() };
        }
        return undefined;
      }),
      set: vi.fn()
    };
    
    mockNext = vi.fn();
  });
  
  it('should pass through when no error occurs', async () => {
    const handler = errorHandler();
    await handler(mockContext, mockNext);
    expect(mockNext).toHaveBeenCalled();
    expect(mockContext.status).not.toHaveBeenCalled();
  });
  
  it('should handle DomeError correctly', async () => {
    const handler = errorHandler();
    mockNext.mockRejectedValue(new ValidationError('Invalid input'));
    
    await handler(mockContext, mockNext);
    
    expect(mockContext.status).toHaveBeenCalledWith(400);
    expect(mockContext.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({
        code: 'VALIDATION_ERROR',
        message: 'Invalid input'
      })
    }));
  });
  
  it('should convert non-DomeError to InternalError', async () => {
    const handler = errorHandler();
    mockNext.mockRejectedValue(new Error('Standard error'));
    
    await handler(mockContext, mockNext);
    
    expect(mockContext.status).toHaveBeenCalledWith(500);
    expect(mockContext.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred'
      })
    }));
  });
  
  it('should use custom error mapper if provided', async () => {
    const errorMapper = vi.fn().mockReturnValue(
      new BadRequestError('Mapped error')
    );
    
    const handler = errorHandler({ errorMapper });
    mockNext.mockRejectedValue(new Error('Original error'));
    
    await handler(mockContext, mockNext);
    
    expect(errorMapper).toHaveBeenCalled();
    expect(mockContext.status).toHaveBeenCalledWith(400);
    expect(mockContext.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({
        code: 'BAD_REQUEST',
        message: 'Mapped error'
      })
    }));
  });
  
  it('should include stack traces when configured and not in production', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    
    const handler = errorHandler({ includeStack: true });
    mockNext.mockRejectedValue(new ValidationError('Invalid input'));
    
    await handler(mockContext, mockNext);
    
    expect(mockContext.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({
        stack: expect.any(String)
      })
    }));
    
    process.env.NODE_ENV = originalEnv;
  });
});