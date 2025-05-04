# Utility Usage Examples

> **Version:** 1.0.0  
> **Package:** `@dome/common`  
> **Stack:** TypeScript 5 · Hono v4

## 1. Overview

This document provides practical usage examples for the utility functions in the `@dome/common` package. These examples demonstrate how to use the utilities in real-world scenarios and can serve as a reference for developers implementing new features or refactoring existing code.

## 2. Error Handling Examples

### 2.1 Basic Error Handling

```typescript
import { NotFoundError, ValidationError } from '@dome/common';

// Throwing specific error types
function getUserById(id: string) {
  // Validate input
  if (!id) {
    throw new ValidationError('User ID is required');
  }

  const user = userRepository.findById(id);

  // Check if user exists
  if (!user) {
    throw new NotFoundError(`User with ID ${id} not found`);
  }

  return user;
}
```

### 2.2 Error Middleware in Hono Application

```typescript
import { Hono } from 'hono';
import { createErrorMiddleware, initLogging } from '@dome/common';
import { z } from 'zod';

const app = new Hono();

// Initialize logging
initLogging(app);

// Add error handling middleware
app.use(
  '*',
  createErrorMiddleware(zodError => {
    // Custom Zod error formatting
    return zodError.errors.map(err => ({
      path: err.path.join('.'),
      message: err.message,
      code: err.code,
    }));
  }),
);

// Route that might throw errors
app.post('/users', async c => {
  const schema = z.object({
    email: z.string().email(),
    name: z.string().min(2),
  });

  // This will be caught by the error middleware if validation fails
  const data = schema.parse(await c.req.json());

  // This might throw a ServiceError
  const user = await createUser(data);

  return c.json({ success: true, data: user });
});

export default app;
```

### 2.3 Error Conversion at Service Boundaries

```typescript
import { createServiceErrorHandler, logError } from '@dome/common';

// Create a service-specific error handler
const toDomeError = createServiceErrorHandler('auth-service');

async function callExternalService() {
  try {
    const response = await fetch('https://api.example.com/data');

    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    // Convert to a properly typed error with service context
    const domeError = toDomeError(error, 'Failed to fetch data from external service', {
      service: 'example-api',
    });

    // Log the error with context
    logError(domeError, 'External API error', {
      operation: 'callExternalService',
    });

    // Rethrow the converted error
    throw domeError;
  }
}
```

## 3. Logging Examples

### 3.1 Structured Logging

```typescript
import { getLogger } from '@dome/common';

function processOrder(order) {
  const logger = getLogger();

  // Log with structured context
  logger.info(
    {
      orderId: order.id,
      customerId: order.customerId,
      amount: order.totalAmount,
      items: order.items.length,
      operation: 'processOrder',
    },
    'Processing order',
  );

  // Process the order...

  // Log success with metrics
  logger.info(
    {
      orderId: order.id,
      processingTime: performance.now() - startTime,
      operation: 'processOrder',
      status: 'success',
    },
    'Order processed successfully',
  );
}
```

### 3.2 Operation Tracking

```typescript
import { trackOperation } from '@dome/common';

async function processPayment(paymentData) {
  // Track the operation with timing and success/failure metrics
  return await trackOperation(
    'processPayment',
    async () => {
      // Validate payment data
      validatePaymentData(paymentData);

      // Process the payment
      const result = await paymentGateway.processPayment(paymentData);

      // Update the database
      await updatePaymentStatus(paymentData.orderId, result.status);

      return result;
    },
    // Additional context for logs
    {
      orderId: paymentData.orderId,
      amount: paymentData.amount,
      currency: paymentData.currency,
      gateway: paymentData.gateway,
    },
  );
}
```

### 3.3 Error Logging

```typescript
import { logError, tryWithErrorLoggingAsync } from '@dome/common';

// Manual error logging
async function processFile(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return parseContent(content);
  } catch (error) {
    logError(error, 'Failed to process file', {
      filePath,
      operation: 'processFile',
    });
    throw error; // Rethrow if needed
  }
}

// Using tryWithErrorLoggingAsync
async function safelyProcessFile(filePath) {
  return await tryWithErrorLoggingAsync(
    async () => {
      const content = await fs.readFile(filePath, 'utf-8');
      return parseContent(content);
    },
    'Failed to process file',
    { filePath, operation: 'safelyProcessFile' },
  );
  // Note: This version returns undefined on error instead of rethrowing
}
```

### 3.4 External API Call Tracking

```typescript
import { trackedFetch } from '@dome/common';

async function fetchUserData(userId) {
  // Make an external API call with tracking
  const response = await trackedFetch(
    `https://api.example.com/users/${userId}`,
    {
      headers: {
        Authorization: `Bearer ${getApiToken()}`,
        'Content-Type': 'application/json',
      },
    },
    {
      operation: 'fetchUserData',
      userId,
    },
  );

  // The call is automatically logged with timing and status

  if (!response.ok) {
    throw new Error(`Failed to fetch user data: ${response.status}`);
  }

  return await response.json();
}
```

## 4. Function Wrapper Examples

### 4.1 Service Wrapper

```typescript
import { createServiceWrapper } from '@dome/common';

// Create a service-specific wrapper
const wrap = createServiceWrapper('user-service');

// Use the wrapper for service functions
async function createUser(userData) {
  return wrap(
    {
      operation: 'createUser',
      email: userData.email,
      userType: userData.type,
    },
    async () => {
      // Validate user data
      validateUserData(userData);

      // Check if user already exists
      const existingUser = await userRepository.findByEmail(userData.email);
      if (existingUser) {
        throw new ValidationError('User with this email already exists', {
          field: 'email',
        });
      }

      // Create the user
      const user = await userRepository.create(userData);

      // Send welcome email
      await emailService.sendWelcomeEmail(user);

      return user;
    },
  );
}
```

### 4.2 Process Chain

```typescript
import { createProcessChain } from '@dome/common';

// Define a process chain for user registration
const registerUser = createProcessChain({
  serviceName: 'user-service',
  operation: 'registerUser',

  // Step 1: Input validation
  inputValidation: input => {
    assertValid(input.email, 'Email is required');
    assertValid(input.password, 'Password is required');
    assertValid(input.password.length >= 8, 'Password must be at least 8 characters');
    assertValid(input.name, 'Name is required');
  },

  // Step 2: Main processing
  process: async input => {
    // Check if user already exists
    const existingUser = await userRepository.findByEmail(input.email);
    if (existingUser) {
      throw new ValidationError('User with this email already exists', {
        field: 'email',
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(input.password, 10);

    // Create user
    const user = await userRepository.create({
      ...input,
      password: hashedPassword,
    });

    // Send welcome email
    await emailService.sendWelcomeEmail(user);

    return user;
  },

  // Step 3: Output validation
  outputValidation: output => {
    assertValid(output.id, 'User ID is missing in the result');
    assertValid(output.email, 'User email is missing in the result');
  },
});

// Use the process chain
app.post('/register', async c => {
  const userData = await c.req.json();
  const user = await registerUser(userData);
  return c.json({ success: true, data: user });
});
```

## 5. Context Management Examples

### 5.1 Using withContext

```typescript
import { withContext, getLogger } from '@dome/common';

async function processRequest(requestData) {
  // Run with context
  return await withContext(
    {
      requestId: requestData.id,
      userId: requestData.userId,
      operation: 'processRequest',
      source: requestData.source,
    },
    async logger => {
      // The logger is pre-configured with the context
      logger.info('Processing request');

      // Process the request
      const result = await processStep1(requestData);
      await processStep2(result);

      logger.info('Request processed successfully');

      return { success: true };
    },
  );
}

// Nested functions can access the context
async function processStep1(data) {
  // Get the logger with the context from the parent function
  const logger = getLogger();
  logger.info({ step: 1 }, 'Processing step 1');

  // Process data
  return transformedData;
}
```

### 5.2 Request Context in HTTP Application

```typescript
import { Hono } from 'hono';
import { initLogging, createRequestContextMiddleware, getLogger, getRequestId } from '@dome/common';

const app = new Hono();

// Initialize logging
initLogging(app);

// Add request context middleware
app.use('*', createRequestContextMiddleware());

// In your handlers, context is automatically available
app.get('/users/:id', async c => {
  const logger = getLogger();
  const userId = c.req.param('id');
  const requestId = getRequestId();

  // Logger automatically includes request ID and other context
  logger.info({ userId }, 'Fetching user');

  // Add request ID to external service calls
  const user = await userService.findById(userId, { requestId });

  if (!user) {
    throw new NotFoundError(`User with ID ${userId} not found`);
  }

  return c.json({ success: true, data: user });
});
```

## 6. Metrics Collection Examples

### 6.1 Service Metrics

```typescript
import { createServiceMetrics } from '@dome/common';

// Create service-specific metrics
const metrics = createServiceMetrics('auth-service');

function trackAuthenticationAttempt(method, success) {
  // Track counter
  metrics.counter('authentication_attempts', 1, {
    method,
    success: String(success),
  });

  // Track operation success/failure
  metrics.trackOperation('authentication', success, { method });
}

async function authenticateUser(credentials) {
  const startTime = performance.now();
  let success = false;

  try {
    // Authenticate user
    const user = await userRepository.findByEmail(credentials.email);

    if (!user) {
      throw new NotFoundError('User not found');
    }

    const isValid = await bcrypt.compare(credentials.password, user.password);

    if (!isValid) {
      throw new UnauthorizedError('Invalid credentials');
    }

    // Authentication successful
    success = true;
    return user;
  } finally {
    // Track metrics regardless of success/failure
    const duration = performance.now() - startTime;

    // Track timing
    metrics.timing('authentication_duration', duration, {
      success: String(success),
    });

    // Track authentication attempt
    trackAuthenticationAttempt('password', success);

    // Track active sessions gauge
    const activeSessions = await sessionRepository.countActive();
    metrics.gauge('active_sessions', activeSessions);
  }
}
```

### 6.2 Operation Timing

```typescript
import { createServiceMetrics } from '@dome/common';

const metrics = createServiceMetrics('data-service');

async function processLargeDataset(datasetId) {
  // Start a timer
  const timer = metrics.startTimer('dataset_processing');

  try {
    // Fetch dataset
    const dataset = await datasetRepository.findById(datasetId);

    // Process data
    const result = await processData(dataset);

    // Store results
    await resultRepository.save(result);

    return result;
  } finally {
    // Stop the timer and get the duration
    const duration = timer.stop({
      datasetId,
      datasetSize: String(dataset?.size || 'unknown'),
    });

    console.log(`Processing took ${duration.toFixed(2)}ms`);
  }
}
```

## 7. Content Sanitization Examples

### 7.1 Log Sanitization

```typescript
import { sanitizeForLogging, getLogger } from '@dome/common';

function processPaymentData(paymentData) {
  const logger = getLogger();

  // Sanitize sensitive data before logging
  const sanitizedData = sanitizeForLogging(paymentData);

  // Safe to log - sensitive fields are masked
  logger.info({ payment: sanitizedData }, 'Processing payment');

  // Original data is unchanged
  processPayment(paymentData);
}

// Example input:
// {
//   userId: '123',
//   cardNumber: '4111111111111111',
//   cvv: '123',
//   expiryDate: '12/25',
//   amount: 99.99
// }

// Sanitized output:
// {
//   userId: '123',
//   cardNumber: '***',
//   cvv: '***',
//   expiryDate: '12/25',
//   amount: 99.99
// }
```

### 7.2 Custom Sanitization

```typescript
import { sanitizeForLogging, getLogger } from '@dome/common';

function processUserData(userData) {
  const logger = getLogger();

  // Sanitize with custom sensitive fields
  const sanitizedData = sanitizeForLogging(userData, [
    'password',
    'ssn',
    'taxId',
    'dob',
    'securityQuestion',
  ]);

  logger.info({ user: sanitizedData }, 'Processing user data');

  // Process the original data
  createUser(userData);
}
```

## 8. Zod Validation Examples

### 8.1 Basic Schema Validation

```typescript
import { createZodValidator, formatZodError } from '@dome/common/utils/zodUtils';
import { z } from 'zod';

// Define a schema
const userSchema = z.object({
  email: z.string().email('Invalid email address'),
  name: z.string().min(2, 'Name must be at least 2 characters'),
  age: z.number().int().positive().optional(),
  role: z.enum(['admin', 'user', 'guest']),
});

// Create a validator
const validateUser = createZodValidator(userSchema);

// Use the validator
try {
  const validatedUser = validateUser({
    email: 'user@example.com',
    name: 'John Doe',
    role: 'user',
  });

  // Process valid data
  createUser(validatedUser);
} catch (error) {
  // Format error for API response
  const formattedErrors = formatZodError(error);

  return c.json(
    {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid user data',
        details: formattedErrors,
      },
    },
    400,
  );
}
```

### 8.2 Integration with Error Middleware

```typescript
import { Hono } from 'hono';
import { createErrorMiddleware } from '@dome/common';
import { formatZodError } from '@dome/common/utils/zodUtils';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';

const app = new Hono();

// Add error middleware with Zod error formatting
app.use('*', createErrorMiddleware(formatZodError));

// Define a schema
const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2),
  password: z.string().min(8),
});

// Use Hono's zValidator middleware
app.post('/users', zValidator('json', createUserSchema), async c => {
  // Validation is handled by zValidator
  // If validation fails, the error is caught by createErrorMiddleware
  const data = c.req.valid('json');

  const user = await createUser(data);

  return c.json({ success: true, data: user });
});

export default app;
```

## 9. Combining Multiple Utilities

### 9.1 Complete Service Example

```typescript
import { Hono } from 'hono';
import {
  initLogging,
  createErrorMiddleware,
  createRequestContextMiddleware,
  getLogger,
  createServiceWrapper,
  trackedFetch,
  sanitizeForLogging,
} from '@dome/common';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

// Initialize application
const app = new Hono();
initLogging(app, { extraBindings: { service: 'payment-service' } });

// Add middleware
app.use('*', createRequestContextMiddleware());
app.use('*', createErrorMiddleware());

// Create service wrapper
const wrap = createServiceWrapper('payment-service');

// Define schemas
const paymentSchema = z.object({
  userId: z.string(),
  amount: z.number().positive(),
  currency: z.string().length(3),
  cardToken: z.string(),
});

// Define routes
app.post('/payments', zValidator('json', paymentSchema), async c => {
  const data = c.req.valid('json');
  const logger = getLogger();

  // Sanitize for logging
  const sanitizedData = sanitizeForLogging(data);
  logger.info({ payment: sanitizedData }, 'Processing payment');

  // Process payment using service wrapper
  const payment = await processPayment(data);

  return c.json({ success: true, data: payment });
});

// Service function with wrapper
async function processPayment(paymentData) {
  return wrap(
    {
      operation: 'processPayment',
      userId: paymentData.userId,
      amount: paymentData.amount,
      currency: paymentData.currency,
    },
    async () => {
      // Call payment gateway
      const response = await trackedFetch(
        'https://api.payment-gateway.com/v1/charges',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${getApiKey()}`,
          },
          body: JSON.stringify({
            amount: paymentData.amount,
            currency: paymentData.currency,
            source: paymentData.cardToken,
            description: `Charge for user ${paymentData.userId}`,
          }),
        },
        { operation: 'paymentGatewayCharge' },
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new ServiceError('Payment processing failed', {
          gatewayError: errorData.error,
          statusCode: response.status,
        });
      }

      const result = await response.json();

      // Save payment record
      const payment = await paymentRepository.create({
        userId: paymentData.userId,
        amount: paymentData.amount,
        currency: paymentData.currency,
        gatewayId: result.id,
        status: result.status,
      });

      return payment;
    },
  );
}

export default app;
```

## 10. Migration Examples

### 10.1 Before and After: Error Handling

#### Before:

```typescript
try {
  const user = await userRepository.findById(userId);

  if (!user) {
    console.error(`User not found: ${userId}`);
    return c.json({ error: 'User not found' }, 404);
  }

  return c.json({ user });
} catch (error) {
  console.error('Error fetching user:', error);
  return c.json({ error: 'Internal server error' }, 500);
}
```

#### After:

```typescript
import { NotFoundError } from '@dome/common';

// With error middleware, you can just throw appropriate errors
const user = await userRepository.findById(userId);

if (!user) {
  throw new NotFoundError(`User with ID ${userId} not found`);
}

return c.json({ success: true, data: user });
```

### 10.2 Before and After: Logging

#### Before:

```typescript
console.log(`Processing payment for user ${userId} with amount ${amount}`);

try {
  const result = await processPayment(userId, amount);
  console.log(`Payment successful: ${result.id}`);
  return result;
} catch (error) {
  console.error(`Payment failed: ${error.message}`);
  throw error;
}
```

#### After:

```typescript
import { getLogger, trackOperation } from '@dome/common';

const logger = getLogger();
logger.info({ userId, amount }, 'Processing payment');

return await trackOperation(
  'processPayment',
  async () => {
    const result = await paymentService.process(userId, amount);
    return result;
  },
  { userId, amount },
);
```

### 10.3 Before and After: Function Wrapper

#### Before:

```typescript
async function createUser(userData) {
  console.log(`Creating user: ${userData.email}`);

  try {
    // Validate
    if (!userData.email) {
      throw new Error('Email is required');
    }

    // Check if exists
    const existingUser = await userRepository.findByEmail(userData.email);
    if (existingUser) {
      throw new Error('User already exists');
    }

    // Create
    const user = await userRepository.create(userData);

    console.log(`User created: ${user.id}`);
    return user;
  } catch (error) {
    console.error(`Error creating user: ${error.message}`);
    throw error;
  }
}
```

#### After:

```typescript
import { createServiceWrapper, ValidationError } from '@dome/common';

const wrap = createServiceWrapper('user-service');

async function createUser(userData) {
  return wrap({ operation: 'createUser', email: userData.email }, async () => {
    // Validate
    if (!userData.email) {
      throw new ValidationError('Email is required', { field: 'email' });
    }

    // Check if exists
    const existingUser = await userRepository.findByEmail(userData.email);
    if (existingUser) {
      throw new ValidationError('User already exists', { field: 'email' });
    }

    // Create
    return await userRepository.create(userData);
  });
}
```

## 11. Conclusion

These examples demonstrate how to use the utility functions in the `@dome/common` package in real-world scenarios. By following these patterns, you can ensure consistent error handling, logging, and context propagation throughout your application.

The utilities are designed to work together seamlessly, allowing you to build robust, maintainable, and observable services with minimal boilerplate code. They encapsulate best practices for error handling, logging, and context management, making it easier to write high-quality code.

For more detailed information about each utility, refer to the [UTILITY_FUNCTIONS.md](./UTILITY_FUNCTIONS.md) document.
