import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServiceWrapper, createProcessChain } from '../../src/utils/functionWrapper';

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

describe('Function Wrapper Integration Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Service Wrapper Integration', () => {
    it('should handle complex nested service calls with error handling', async () => {
      // Import mocked dependencies
      const { ValidationError } = require('@dome/errors');
      const { logError, trackOperation } = require('@dome/common');

      // Create service wrappers for different services
      const wrapUserService = createServiceWrapper('user-service');
      const wrapAuthService = createServiceWrapper('auth-service');
      const wrapPaymentService = createServiceWrapper('payment-service');

      // Mock database operations
      const mockDb = {
        findUser: vi.fn().mockImplementation(id => {
          if (id === 'valid-user') {
            return Promise.resolve({ id, name: 'Test User', email: 'test@example.com' });
          }
          return Promise.resolve(null);
        }),
        validateCredentials: vi.fn().mockImplementation((email, password) => {
          if (password === 'valid-password') {
            return Promise.resolve(true);
          }
          return Promise.resolve(false);
        }),
        processPayment: vi.fn().mockImplementation((userId, amount) => {
          if (amount <= 0) {
            return Promise.reject(new Error('Invalid payment amount'));
          }
          return Promise.resolve({ id: 'payment-123', status: 'success' });
        }),
      };

      // Create service functions
      const getUserById = async (userId: string) => {
        return wrapUserService({ operation: 'getUserById', userId }, async () => {
          const user = await mockDb.findUser(userId);
          if (!user) {
            throw new ValidationError('User not found', { userId });
          }
          return user;
        });
      };

      const authenticateUser = async (email: string, password: string) => {
        return wrapAuthService({ operation: 'authenticateUser', email }, async () => {
          const isValid = await mockDb.validateCredentials(email, password);
          if (!isValid) {
            throw new ValidationError('Invalid credentials');
          }
          return { authenticated: true };
        });
      };

      const processUserPayment = async (userId: string, amount: number) => {
        return wrapPaymentService({ operation: 'processPayment', userId, amount }, async () => {
          // First verify the user exists
          const user = await getUserById(userId);

          // Then process the payment
          const payment = await mockDb.processPayment(userId, amount);

          return { success: true, payment, user };
        });
      };

      // Test successful flow
      const successResult = await processUserPayment('valid-user', 100);
      expect(successResult).toEqual({
        success: true,
        payment: { id: 'payment-123', status: 'success' },
        user: { id: 'valid-user', name: 'Test User', email: 'test@example.com' },
      });

      // Verify tracking was called for each service
      expect(trackOperation).toHaveBeenCalledWith(
        'payment-service.processPayment',
        expect.any(Function),
        expect.objectContaining({ userId: 'valid-user', amount: 100 }),
      );

      // Test error flow - invalid user
      try {
        await processUserPayment('invalid-user', 100);
        // Should not reach here
        expect(true).toBe(false);
      } catch (error: any) {
        expect(error.code).toBe('VALIDATION_ERROR');
        expect(error.message).toContain('User not found');
        expect(error.details).toHaveProperty('userId', 'invalid-user');

        // Verify error was logged
        expect(logError).toHaveBeenCalled();
      }

      // Test error flow - invalid amount
      try {
        await processUserPayment('valid-user', -10);
        // Should not reach here
        expect(true).toBe(false);
      } catch (error: any) {
        expect(error.message).toContain('Invalid payment amount');

        // Verify error was logged
        expect(logError).toHaveBeenCalled();
      }
    });
  });

  describe('Process Chain Integration', () => {
    it('should handle multi-step processes with validation', async () => {
      // Import mocked dependencies
      const { ValidationError } = require('@dome/errors');

      // Create validators
      const validateOrderInput = (input: any) => {
        if (!input.userId) throw new ValidationError('User ID is required');
        if (!input.items || !input.items.length) throw new ValidationError('Order must have items');
        if (!input.shippingAddress) throw new ValidationError('Shipping address is required');
      };

      const validateOrderOutput = (output: any) => {
        if (!output.orderId) throw new ValidationError('Order ID is missing in output');
        if (!output.status) throw new ValidationError('Order status is missing in output');
      };

      // Create process function
      const processOrder = async (input: any) => {
        // Calculate total
        const total = input.items.reduce(
          (sum: number, item: any) => sum + item.price * item.quantity,
          0,
        );

        // Apply discount if applicable
        const discount = input.discountCode ? 0.1 : 0;
        const finalTotal = total * (1 - discount);

        // Create order
        return {
          orderId: 'order-' + Date.now(),
          userId: input.userId,
          items: input.items,
          shippingAddress: input.shippingAddress,
          total: finalTotal,
          discount: discount > 0 ? `${discount * 100}%` : null,
          status: 'created',
          createdAt: new Date().toISOString(),
        };
      };

      // Create process chain
      const createOrder = createProcessChain({
        serviceName: 'order-service',
        operation: 'createOrder',
        inputValidation: validateOrderInput,
        process: processOrder,
        outputValidation: validateOrderOutput,
      });

      // Test valid input
      const validInput = {
        userId: 'user-123',
        items: [
          { id: 'item-1', name: 'Product 1', price: 10, quantity: 2 },
          { id: 'item-2', name: 'Product 2', price: 15, quantity: 1 },
        ],
        shippingAddress: '123 Main St, City, Country',
        discountCode: 'DISCOUNT10',
      };

      const result = await createOrder(validInput);

      expect(result).toHaveProperty('orderId');
      expect(result).toHaveProperty('userId', 'user-123');
      expect(result).toHaveProperty('total', 31.5); // (10*2 + 15*1) * 0.9
      expect(result).toHaveProperty('status', 'created');

      // Test invalid input - missing userId
      const invalidInput1 = {
        items: [{ id: 'item-1', name: 'Product 1', price: 10, quantity: 2 }],
        shippingAddress: '123 Main St, City, Country',
      };

      try {
        await createOrder(invalidInput1);
        // Should not reach here
        expect(true).toBe(false);
      } catch (error: any) {
        expect(error.code).toBe('VALIDATION_ERROR');
        expect(error.message).toContain('User ID is required');
      }

      // Test invalid input - no items
      const invalidInput2 = {
        userId: 'user-123',
        items: [],
        shippingAddress: '123 Main St, City, Country',
      };

      try {
        await createOrder(invalidInput2);
        // Should not reach here
        expect(true).toBe(false);
      } catch (error: any) {
        expect(error.code).toBe('VALIDATION_ERROR');
        expect(error.message).toContain('Order must have items');
      }
    });
  });

  describe('Performance Characteristics', () => {
    it('should handle high volume of operations efficiently', async () => {
      // Create a simple wrapper
      const wrap = createServiceWrapper('test-service');

      // Create a test function
      const testFunction = async (id: number) => {
        return wrap({ operation: 'testOp', id }, async () => {
          return { id, result: id * 2 };
        });
      };

      // Run multiple operations in parallel
      const startTime = Date.now();

      const results = await Promise.all(Array.from({ length: 100 }, (_, i) => testFunction(i)));

      const endTime = Date.now();
      const duration = endTime - startTime;

      // Verify results
      expect(results).toHaveLength(100);
      expect(results[0]).toEqual({ id: 0, result: 0 });
      expect(results[99]).toEqual({ id: 99, result: 198 });

      // This is a loose performance test - mainly checking that the wrapper
      // doesn't add significant overhead
      console.log(`Processed 100 operations in ${duration}ms`);

      // In a real test environment, we might have a more specific threshold
      // but for this test we're just ensuring it completes in a reasonable time
      expect(duration).toBeLessThan(5000); // Very generous threshold
    });
  });
});
