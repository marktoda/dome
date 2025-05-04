import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withContext } from '../../src/context';

// Mock dependencies
vi.mock('@dome/common', () => {
  const mockLogger: {
    info: any;
    error: any;
    warn: any;
    debug: any;
    child: any;
  } = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => mockLogger),
  };

  return {
    getLogger: vi.fn(() => mockLogger),
    baseLogger: mockLogger,
    createLogger: vi.fn(() => mockLogger),
  };
});

// Mock AsyncLocalStorage
const mockAsyncLocalStorage = {
  getStore: vi.fn(),
  run: vi.fn((store, fn) => {
    mockAsyncLocalStorage.getStore.mockReturnValue(store);
    return fn();
  }),
};

vi.mock('async_hooks', () => ({
  AsyncLocalStorage: vi.fn(() => mockAsyncLocalStorage),
}));

describe('Logger Context Propagation Integration Tests', () => {
  const { getLogger } = require('@dome/common');
  
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should propagate context through nested function calls', async () => {
    // Define nested functions that use the logger
    const innerFunction = () => {
      const logger = getLogger();
      logger.info('Inner function log');
      return 'inner result';
    };

    const middleFunction = () => {
      const logger = getLogger();
      logger.info('Middle function log');
      return innerFunction();
    };

    const outerFunction = () => {
      const logger = getLogger();
      logger.info('Outer function log');
      return middleFunction();
    };

    // Set up context and run the nested functions
    const result = await withContext(
      { requestId: 'test-123', userId: 'user-456', operation: 'test-operation' },
      async () => {
        return outerFunction();
      }
    );

    // Verify result
    expect(result).toBe('inner result');

    // Verify context was propagated to all logger calls
    const mockLogger = getLogger();
    
    // All log calls should have been made with the same context
    expect(mockLogger.info).toHaveBeenCalledTimes(3);
    
    // Check that the context was passed to each call
    const contextCaptor = mockAsyncLocalStorage.run.mock.calls[0][0];
    expect(contextCaptor).toEqual(
      expect.objectContaining({
        requestId: 'test-123',
        userId: 'user-456',
        operation: 'test-operation',
      })
    );
  });

  it('should merge contexts when nested withContext calls are made', async () => {
    // Run with nested contexts
    await withContext(
      { requestId: 'test-123', service: 'service1' },
      async () => {
        const logger1 = getLogger();
        logger1.info('Log from outer context');

        await withContext(
          { operation: 'nested-op', component: 'component1' },
          async () => {
            const logger2 = getLogger();
            logger2.info('Log from inner context');
          }
        );
      }
    );

    // Verify outer context
    const outerContextCaptor = mockAsyncLocalStorage.run.mock.calls[0][0];
    expect(outerContextCaptor).toEqual(
      expect.objectContaining({
        requestId: 'test-123',
        service: 'service1',
      })
    );

    // Verify inner context (merged)
    const innerContextCaptor = mockAsyncLocalStorage.run.mock.calls[1][0];
    expect(innerContextCaptor).toEqual(
      expect.objectContaining({
        requestId: 'test-123',
        service: 'service1',
        operation: 'nested-op',
        component: 'component1',
      })
    );
  });

  it('should handle async operations while maintaining context', async () => {
    // Mock Promise.all and other async operations
    const asyncOperation1 = vi.fn().mockImplementation(async () => {
      const logger = getLogger();
      logger.info('Async operation 1');
      return 'result1';
    });

    const asyncOperation2 = vi.fn().mockImplementation(async () => {
      const logger = getLogger();
      logger.info('Async operation 2');
      return 'result2';
    });

    // Run with context
    const results = await withContext(
      { requestId: 'test-123', operation: 'parallel-ops' },
      async () => {
        return Promise.all([
          asyncOperation1(),
          asyncOperation2(),
        ]);
      }
    );

    // Verify results
    expect(results).toEqual(['result1', 'result2']);

    // Verify context was maintained in both async operations
    expect(asyncOperation1).toHaveBeenCalled();
    expect(asyncOperation2).toHaveBeenCalled();
    
    // Both operations should have logged with the same context
    const mockLogger = getLogger();
    expect(mockLogger.info).toHaveBeenCalledTimes(2);
    
    // Check that the context was passed to each call
    const contextCaptor = mockAsyncLocalStorage.run.mock.calls[0][0];
    expect(contextCaptor).toEqual(
      expect.objectContaining({
        requestId: 'test-123',
        operation: 'parallel-ops',
      })
    );
  });

  it('should handle errors while preserving context', async () => {
    // Function that throws an error
    const throwingFunction = () => {
      const logger = getLogger();
      logger.info('About to throw');
      throw new Error('Test error');
    };

    // Run with context and catch the error
    try {
      await withContext(
        { requestId: 'test-123', operation: 'error-op' },
        async () => {
          return throwingFunction();
        }
      );
      // Should not reach here
      expect(true).toBe(false);
    } catch (error: any) {
      expect(error.message).toBe('Test error');
      
      // Verify the log was made with context before the error
      const mockLogger = getLogger();
      expect(mockLogger.info).toHaveBeenCalledWith('About to throw');
      
      // Check that the context was passed to the log call
      const contextCaptor = mockAsyncLocalStorage.run.mock.calls[0][0];
      expect(contextCaptor).toEqual(
        expect.objectContaining({
          requestId: 'test-123',
          operation: 'error-op',
        })
      );
    }
  });
});