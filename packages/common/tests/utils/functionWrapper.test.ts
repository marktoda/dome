import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
// IMPORTANT: Mock paths for ESM need to be exact, including extensions if applicable.
// However, for external packages like '@dome/errors' or '@dome/common',
// the .js extension is usually not needed in the mock path itself, as Node's
// resolution (even under NodeNext) will handle it based on the package's "exports" or "main".
// The critical part is that the *imported* modules from these packages are ESM compatible.
vi.mock('@dome/errors', () => ({
  toDomeError: vi.fn((error, message, details) => ({
    message: message || (error instanceof Error ? error.message : 'Unknown error'),
    code: 'MOCKED_ERROR',
    details: details || {},
  })),
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

// Now import the module to be tested, with .js extension
import { createServiceWrapper, createProcessChain } from '../../src/utils/functionWrapper.js';
// Mock dependencies are already at the top

describe('Function Wrapper Utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createServiceWrapper', () => {
    it('should create a service-specific wrapper function', () => {
      const wrap = createServiceWrapper('test-service');
      expect(typeof wrap).toBe('function');
    });

    it('should call the wrapped function and return its result', async () => {
      const wrap = createServiceWrapper('test-service');
      const fn = vi.fn().mockResolvedValue('test-result');
      const result = await wrap({}, fn);

      expect(fn).toHaveBeenCalled();
      expect(result).toBe('test-result');
    });

    it('should add service name to context metadata', async () => {
      // For ESM, dynamic require is not standard. Mocks are hoisted.
      // We need to import `withContext` from the mocked `@dome/common` at the top.
      // However, since it's already mocked, we can directly access it.
      const { withContext } = await vi.importActual<typeof import('@dome/common')>('@dome/common');
      const wrap = createServiceWrapper('test-service');
      const fn = vi.fn().mockResolvedValue('test-result');

      await wrap({}, fn);

      expect(withContext).toHaveBeenCalledWith(
        expect.objectContaining({ service: 'test-service' }),
        expect.any(Function),
      );
    });

    it('should use trackOperation for named operations', async () => {
      const { trackOperation } = await vi.importActual<typeof import('@dome/common')>(
        '@dome/common',
      );
      const wrap = createServiceWrapper('test-service');
      const fn = vi.fn().mockResolvedValue('test-result');

      await wrap({ operation: 'test-op' }, fn);

      expect(trackOperation).toHaveBeenCalledWith(
        'test-service.test-op',
        expect.any(Function),
        expect.any(Object),
      );
    });

    it('should skip tracking if skipTracking is true', async () => {
      const { trackOperation } = await vi.importActual<typeof import('@dome/common')>(
        '@dome/common',
      );
      const wrap = createServiceWrapper('test-service');
      const fn = vi.fn().mockResolvedValue('test-result');

      await wrap({ operation: 'test-op', skipTracking: true }, fn);

      expect(trackOperation).not.toHaveBeenCalled();
    });

    it('should handle and log errors', async () => {
      const { logError } = await vi.importActual<typeof import('@dome/common')>('@dome/common');
      const wrap = createServiceWrapper('test-service');
      const error = new Error('Test error');
      const fn = vi.fn().mockRejectedValue(error);

      try {
        await wrap({ operation: 'test-op' }, fn);
        // Should not reach here
        expect(true).toBe(false);
      } catch (e) {
        expect(logError).toHaveBeenCalledWith(
          expect.objectContaining({
            message: expect.stringContaining('test-service'),
            code: 'MOCKED_ERROR',
          }),
          expect.stringContaining('test-service'),
          expect.objectContaining({ operation: 'test-op' }),
        );
      }
    });

    it('should preserve error type for DomeErrors', async () => {
      const domeError = {
        message: 'Domain error',
        code: 'DOMAIN_ERROR',
        details: { test: true },
      };

      const wrap = createServiceWrapper('test-service');
      const fn = vi.fn().mockRejectedValue(domeError);

      try {
        await wrap({}, fn);
        // Should not reach here
        expect(true).toBe(false);
      } catch (e) {
        expect(e).toBe(domeError);
      }
    });
  });

  describe('createProcessChain', () => {
    it('should create a process chain function', () => {
      const processChain = createProcessChain({
        serviceName: 'test-service',
        operation: 'test-op',
        process: async () => 'test-result',
      });

      expect(typeof processChain).toBe('function');
    });

    it('should call input validation if provided', async () => {
      const inputValidation = vi.fn();
      const process = vi.fn().mockResolvedValue('test-result');

      const processChain = createProcessChain({
        serviceName: 'test-service',
        operation: 'test-op',
        inputValidation,
        process,
      });

      const input = { test: true };
      await processChain(input);

      expect(inputValidation).toHaveBeenCalledWith(input);
      expect(process).toHaveBeenCalledWith(input);
    });

    it('should call output validation if provided', async () => {
      const outputValidation = vi.fn();
      const process = vi.fn().mockResolvedValue('test-result');

      const processChain = createProcessChain({
        serviceName: 'test-service',
        operation: 'test-op',
        process,
        outputValidation,
      });

      await processChain({});

      expect(outputValidation).toHaveBeenCalledWith('test-result');
    });

    it('should use service wrapper for error handling', async () => {
      const error = new Error('Test error');
      const process = vi.fn().mockRejectedValue(error);

      const processChain = createProcessChain({
        serviceName: 'test-service',
        operation: 'test-op',
        process,
      });

      try {
        await processChain({});
        // Should not reach here
        expect(true).toBe(false);
      } catch (e) {
        expect(e).toHaveProperty('code', 'MOCKED_ERROR');
        expect(e).toHaveProperty('message', expect.stringContaining('test-service'));
      }
    });

    it('should propagate validation errors', async () => {
      const validationError = new Error('Validation failed');
      const inputValidation = vi.fn().mockImplementation(() => {
        throw validationError;
      });
      const process = vi.fn().mockResolvedValue('test-result');

      const processChain = createProcessChain({
        serviceName: 'test-service',
        operation: 'test-op',
        inputValidation,
        process,
      });

      try {
        await processChain({});
        // Should not reach here
        expect(true).toBe(false);
      } catch (e) {
        expect(e).toHaveProperty('code', 'MOCKED_ERROR');
        expect(process).not.toHaveBeenCalled();
      }
    });
  });
});
