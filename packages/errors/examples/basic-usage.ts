/**
 * @dome/errors Basic Usage Examples
 *
 * This file demonstrates the fundamental patterns for using the @dome/errors package
 * including error creation, error handling, and middleware integration.
 */

import {
  DomeError,
  ValidationError,
  NotFoundError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  InternalError,
  ConflictError,
  ServiceUnavailableError,
  RateLimitError,
  toDomeError,
  assertValid,
  assertExists,
  handleDatabaseError,
  createErrorFactory,
} from '../src';

// -----------------------------------------------
// Basic Error Creation and Handling
// -----------------------------------------------

/**
 * Example function demonstrating basic error creation
 */
function validateInput(data: any): void {
  // Using specific error types for different validation scenarios
  if (!data) {
    throw new ValidationError('Data is required');
  }

  if (!data.id) {
    // With additional details
    throw new ValidationError('ID is required', { field: 'id' });
  }

  if (typeof data.email !== 'string' || !data.email.includes('@')) {
    // With detailed context
    throw new ValidationError('Invalid email format', {
      field: 'email',
      value: data.email,
      expected: 'valid email format with @ symbol',
    });
  }

  if (data.age && (typeof data.age !== 'number' || data.age < 18)) {
    throw new ValidationError('Age must be at least 18', {
      field: 'age',
      value: data.age,
      minValue: 18,
    });
  }
}

/**
 * Example function demonstrating error handling patterns
 */
async function processUserData(userData: any): Promise<any> {
  try {
    // Validate input
    validateInput(userData);

    // Try to find existing user
    const existingUser = await findUserByEmail(userData.email);

    // Check for duplicate
    if (existingUser) {
      throw new ConflictError('User with this email already exists', {
        email: userData.email,
        existingUserId: existingUser.id,
      });
    }

    // Create user (which might throw various errors)
    return await createUser(userData);
  } catch (error) {
    // Convert unknown errors to DomeErrors and add context
    if (!(error instanceof DomeError)) {
      error = toDomeError(error, 'Failed to process user data', { operation: 'processUserData' });
    }

    // Re-throw the error after ensuring it's properly typed
    throw error;
  }
}

// -----------------------------------------------
// Advanced Usage with Assertion Helpers
// -----------------------------------------------

/**
 * Example showing assertion helpers
 */
function processOrder(orderId: string | null, items: any[]): any {
  // Assert that order ID exists (throws NotFoundError if null/undefined)
  assertExists(orderId, 'Order ID is required');

  // Assert valid conditions (throws ValidationError if false)
  assertValid(items.length > 0, 'Order must contain at least one item');
  assertValid(
    items.every(item => item.price > 0),
    'All items must have a positive price',
    { items: items.map(i => i.id) },
  );

  // Process the valid order
  return {
    orderId,
    itemCount: items.length,
    total: items.reduce((sum, item) => sum + item.price, 0),
  };
}

// -----------------------------------------------
// Database Error Handling
// -----------------------------------------------

/**
 * Example of handling database errors
 */
async function createUserInDatabase(userData: any): Promise<any> {
  try {
    // Attempt to create user in database
    return await database.users.create({ data: userData });
  } catch (dbError) {
    // Automatically convert database errors to appropriate DomeErrors
    throw handleDatabaseError(dbError, 'createUser', { email: userData.email });

    /* This will automatically:
     * - Convert "not found" errors to NotFoundError
     * - Convert unique constraint violations to ConflictError
     * - Convert foreign key constraint errors to ValidationError
     * - Convert other database errors to InternalError
     */
  }
}

// -----------------------------------------------
// Domain-Specific Error Factory
// -----------------------------------------------

// Create an error factory for the Users domain
const userErrors = createErrorFactory('UserService', {
  component: 'user-management',
});

/**
 * Example using domain-specific error factory
 */
function validateUserWithErrorFactory(user: any): void {
  // These errors will be prefixed with [UserService]
  if (!user.email) {
    throw userErrors.validation('Email is required', { field: 'email' });
  }

  if (!user.password || user.password.length < 8) {
    throw userErrors.validation('Password must be at least 8 characters', {
      field: 'password',
    });
  }

  // Using assertion helpers
  userErrors.assertValid(
    user.username && user.username.length >= 3,
    'Username must be at least 3 characters',
    { field: 'username' },
  );
}

/**
 * Example using the error wrapper from the factory
 */
async function updateUserWithErrorWrapper(userId: string, userData: any): Promise<any> {
  return userErrors.wrap(
    async () => {
      // This operation will be wrapped with error handling
      const user = await findUserById(userId);

      if (!user) {
        throw userErrors.notFound(`User with ID ${userId} not found`);
      }

      if (user.role === 'admin' && userData.role !== 'admin') {
        throw userErrors.forbidden('Cannot change admin role');
      }

      // Update the user
      return await updateUser(userId, userData);
    },
    'Failed to update user', // Default message if an unknown error occurs
    { userId, operation: 'updateUser' }, // Context added to any error
  );
}

// -----------------------------------------------
// Error Chaining
// -----------------------------------------------

/**
 * Example of error chaining for preserving root causes
 */
async function processPayment(paymentId: string, amount: number): Promise<any> {
  try {
    // Attempt to process payment
    return await paymentProcessor.process(paymentId, amount);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('insufficient funds')) {
        throw new BadRequestError(
          'Payment failed: insufficient funds',
          { paymentId, amount },
          error, // Preserve original error as cause
        );
      }

      if (error.message.includes('service unavailable')) {
        throw new ServiceUnavailableError(
          'Payment processor is currently unavailable',
          {
            paymentId,
            retryAfter: '30 seconds',
          },
          error, // Preserve original error as cause
        );
      }
    }

    // For other errors, wrap as InternalError
    throw new InternalError(
      'Payment processing failed',
      { paymentId, amount },
      error instanceof Error ? error : undefined,
    );
  }
}

// -----------------------------------------------
// API Authentication and Authorization
// -----------------------------------------------

/**
 * Example of authentication and authorization checks
 */
function checkAccess(user: any | null, resourceId: string, action: string): void {
  // Authentication check
  if (!user) {
    throw new UnauthorizedError('Authentication required');
  }

  // Token expiration check
  if (user.tokenExpired) {
    throw new UnauthorizedError('Authentication token expired', {
      expiredAt: user.tokenExpiration,
    });
  }

  // Authorization check
  if (action === 'delete' && user.role !== 'admin') {
    throw new ForbiddenError('Admin access required for deletion', {
      requiredRole: 'admin',
      userRole: user.role,
      resourceId,
    });
  }

  // Resource ownership check
  if (action === 'update' && user.role !== 'admin' && user.id !== getResourceOwnerId(resourceId)) {
    throw new ForbiddenError('You can only update your own resources', {
      resourceId,
      ownerId: getResourceOwnerId(resourceId),
      userId: user.id,
    });
  }
}

// -----------------------------------------------
// Rate Limiting Example
// -----------------------------------------------

const RATE_LIMIT = 100;
const rateLimitStore: Record<string, { count: number; resetAt: number }> = {};

/**
 * Example of rate limiting
 */
function checkRateLimit(userId: string): void {
  // Initialize rate limit data if not exists
  if (!rateLimitStore[userId]) {
    rateLimitStore[userId] = {
      count: 0,
      resetAt: Date.now() + 3600000, // 1 hour window
    };
  }

  const limitData = rateLimitStore[userId];

  // Check if window has passed
  if (Date.now() > limitData.resetAt) {
    // Reset counter for new window
    limitData.count = 0;
    limitData.resetAt = Date.now() + 3600000;
  }

  // Increment counter
  limitData.count++;

  // Check limit
  if (limitData.count > RATE_LIMIT) {
    throw new RateLimitError('Rate limit exceeded', {
      limit: RATE_LIMIT,
      current: limitData.count,
      resetAt: new Date(limitData.resetAt).toISOString(),
      timeRemaining: Math.ceil((limitData.resetAt - Date.now()) / 1000),
    });
  }
}

// -----------------------------------------------
// Mock implementations of referenced functions
// -----------------------------------------------

// These would be actual implementations in a real application
async function findUserByEmail(email: string): Promise<any | null> {
  return null; // Simulating no user found
}

async function createUser(userData: any): Promise<any> {
  return { id: '123', ...userData };
}

async function findUserById(id: string): Promise<any | null> {
  return { id, role: 'user', name: 'Test User' };
}

async function updateUser(id: string, data: any): Promise<any> {
  return { id, ...data };
}

function getResourceOwnerId(resourceId: string): string {
  return 'owner-123';
}

// Mock database
const database = {
  users: {
    create: async (opts: any) => ({ id: '123', ...opts.data }),
  },
};

// Mock payment processor
const paymentProcessor = {
  process: async (id: string, amount: number) => ({ id, amount, success: true }),
};
