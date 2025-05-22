# Utility Functions

> **Version:** 1.0.0  
> **Package:** `@dome/common`  
> **Stack:** TypeScript 5 · Hono v4

## 1. Overview

The Dome platform includes a comprehensive set of utility functions in the `@dome/common` package that provide standardized patterns for common operations. These utilities help ensure consistency, reduce boilerplate code, and implement best practices across all services.

This document outlines the key utility functions available, their usage patterns, and best practices for implementation.

## 2. Function Wrappers

### 2.1 Service Wrapper

The `createServiceWrapper` function creates a service-specific wrapper that provides consistent error handling, logging, and context propagation:

```typescript
import { createServiceWrapper } from '@dome/common';

// Create a service-specific wrapper
const wrap = createServiceWrapper('auth-service');

// Use the wrapper for service functions
async function authenticateUser(credentials) {
  return wrap({ operation: 'authenticateUser', userId: credentials.userId }, async () => {
    // Implementation with automatic:
    // - Error handling and conversion
    // - Context propagation
    // - Operation tracking
    // - Structured logging
  });
}
```

#### Key Features

- Automatically tracks operations with timing metrics
- Propagates context through AsyncLocalStorage
- Converts errors to appropriate types with service context
- Provides structured logging with operation metadata
- Simplifies error handling at service boundaries

### 2.2 Process Chain

The `createProcessChain` function breaks down complex operations into discrete steps with proper validation and error handling:

```typescript
import { createProcessChain } from '@dome/common';

const processUserRegistration = createProcessChain({
  serviceName: 'user-service',
  operation: 'registerUser',

  // Step 1: Input validation
  inputValidation: input => {
    assertValid(input.email, 'Email is required');
    assertValid(input.password, 'Password is required');
  },

  // Step 2: Main processing
  process: async input => {
    // Implementation with automatic error handling
    return createdUser;
  },

  // Step 3: Output validation
  outputValidation: output => {
    assertValid(output.id, 'User ID is missing in the result');
  },
});

// Use the process chain
const user = await processUserRegistration(registrationData);
```

#### Key Features

- Separates validation from processing logic
- Provides consistent error handling at each step
- Automatically logs operation details
- Simplifies complex workflows
- Enforces input and output validation

### 2.3 BaseWorker Utilities

`BaseWorker` now exposes helper properties for common service patterns:

```typescript
class MyWorker extends BaseWorker<Env, Services> {
  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, env, buildServices, { serviceName: 'my-worker' });
  }

  async doSomething() {
    return this.wrap({ operation: 'doSomething' }, async () => {
      this.logger.info('doing work');
      const res = await this.trackedFetch('https://api.example.com');
      return res.ok;
    });
  }
}
```

#### Key Features

- `logger` property scoped to the service name
- `wrap(meta, fn)` for standardized context and error handling
- `trackedFetch` for external calls with automatic logging

## 3. Context Management

### 3.1 Context Propagation

The context utilities provide a way to maintain context across asynchronous operations:

```typescript
import { withContext, getContext } from '@dome/common';

// Run a function with context
const result = await withContext({ requestId, userId, operation: 'processData' }, async logger => {
  // The logger is pre-configured with the context
  logger.info('Processing data');

  // The context is available to all functions called from here
  await processStep1();
  await processStep2();

  return result;
});

// Access context in nested functions
function processStep1() {
  // Get the current context
  const context = getContext();
  const requestId = context.get('requestId');

  // Use the context-aware logger
  const logger = getLogger();
  logger.info({ step: 1 }, 'Processing step 1');
}
```

#### Key Features

- Maintains context across async operations using AsyncLocalStorage
- Provides access to context-aware logger
- Simplifies request tracing across function calls
- Enables consistent logging with contextual information

### 3.2 Request Context

The request context middleware automatically sets up context for HTTP requests:

```typescript
import { Hono } from 'hono';
import { initLogging, requestContextMiddleware } from '@dome/common';

const app = new Hono();
initLogging(app);

// Add request context middleware
app.use('*', requestContextMiddleware());

// In your handlers, context is automatically available
app.get('/users/:id', async c => {
  const logger = getLogger();
  // Logger automatically includes request ID and other context
  logger.info({ userId: c.req.param('id') }, 'Fetching user');
});
```

#### Key Features

- Automatically extracts request ID from headers
- Propagates request context to all handlers
- Integrates with logging system
- Simplifies request tracing

## 4. Content Sanitizers

### 4.1 Log Sanitization

The `sanitizeForLogging` function redacts sensitive information before logging:

```typescript
import { sanitizeForLogging, getLogger } from '@dome/common';

function processUserData(userData) {
  // Sanitize sensitive data before logging
  const sanitizedData = sanitizeForLogging(userData);
  getLogger().info({ user: sanitizedData }, 'Processing user data');

  // Process the original data
  // ...
}
```

#### Key Features

- Automatically redacts common sensitive fields (password, token, secret, etc.)
- Handles nested objects recursively
- Preserves object structure for debugging
- Customizable sensitive field list

### 4.2 Content Sanitizers

The content sanitizers provide utilities for cleaning and normalizing content:

```typescript
import { sanitizeHtml, normalizeText } from '@dome/common/utils/contentSanitizers';

// Sanitize HTML content
const cleanHtml = sanitizeHtml(userProvidedHtml);

// Normalize text for processing
const normalizedText = normalizeText(rawText);
```

#### Key Features

- Removes potentially dangerous HTML
- Normalizes whitespace and special characters
- Handles common encoding issues
- Provides consistent text processing

## 5. Zod Utilities

### 5.1 Schema Validation

The Zod utilities provide enhanced schema validation:

```typescript
import { createZodValidator, formatZodError } from '@dome/common/utils/zodUtils';
import { z } from 'zod';

// Define a schema
const userSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2),
  age: z.number().optional(),
});

// Create a validator
const validateUser = createZodValidator(userSchema);

// Use the validator
try {
  const validatedUser = validateUser(userData);
  // Process valid data
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

#### Key Features

- Integrates with error handling system
- Provides user-friendly error messages
- Formats errors consistently for API responses
- Simplifies schema validation

## 6. Metrics Collection

### 6.1 Service Metrics

The metrics utilities provide standardized metrics collection:

```typescript
import { createServiceMetrics } from '@dome/common';

// Create service-specific metrics
const metrics = createServiceMetrics('auth-service');

// Track counters
metrics.counter('login_attempts');

// Track gauges
metrics.gauge('active_sessions', activeSessionCount);

// Track timing
metrics.timing('login_duration', loginDuration);

// Start a timer
const timer = metrics.startTimer('operation_duration');
// ... operation
const duration = timer.stop();

// Track operation success/failure
metrics.trackOperation('user_authentication', success, { method: 'password' });
```

#### Key Features

- Standardized metrics naming
- Consistent tagging
- Integration with monitoring systems
- Simplified API for common metrics types

## 7. External API Calls

### 7.1 Tracked Fetch

The `trackedFetch` utility provides standardized logging for external API calls:

```typescript
import { trackedFetch } from '@dome/common';

// Make an external API call with tracking
const response = await trackedFetch(
  'https://api.example.com/data',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  },
  { operation: 'fetchExternalData' },
);

// Process the response
const responseData = await response.json();
```

#### Key Features

- Automatically logs request and response details
- Tracks timing information
- Propagates request ID to external services
- Handles errors consistently
- Integrates with metrics collection

## 8. Error Handling Utilities

### 8.1 Error Logging

The error logging utilities provide enhanced error logging:

```typescript
import { logError, tryWithErrorLogging } from '@dome/common';

// Log an error with context
try {
  // Operation
} catch (error) {
  logError(error, 'Failed to process request', { requestId, userId });
  throw error;
}

// Try an operation with automatic error logging
const result = tryWithErrorLogging(() => riskyOperation(), 'Failed to perform risky operation', {
  context: 'additional context',
});

// Async version
const asyncResult = await tryWithErrorLoggingAsync(
  () => asyncRiskyOperation(),
  'Failed to perform async risky operation',
  { context: 'additional context' },
);
```

#### Key Features

- Extracts detailed error information
- Includes stack traces in development
- Handles different error types consistently
- Provides context for debugging

### 8.2 Error Conversion

The error conversion utilities help convert errors to appropriate types:

```typescript
import { createServiceErrorHandler } from '@dome/common';

// Create a service-specific error handler
const toDomeError = createServiceErrorHandler('auth-service');

try {
  // Operation that might throw
} catch (error) {
  // Convert to a properly typed error with service context
  throw toDomeError(error, 'Failed to authenticate user', { userId });
}
```

#### Key Features

- Converts generic errors to typed errors
- Preserves original error information
- Adds service-specific context
- Integrates with logging system

## 9. Best Practices

### 9.1 Function Organization

- Group related functions in service-specific modules
- Use the service wrapper for all public service functions
- Separate validation logic from processing logic
- Use process chains for complex operations

### 9.2 Error Handling

- Always use typed errors instead of generic Error instances
- Include contextual information in error details
- Use error conversion at service boundaries
- Log errors before rethrowing them

### 9.3 Context Propagation

- Use withContext for operations that span multiple functions
- Pass context explicitly when crossing service boundaries
- Include operation names in context for better tracing
- Use request context middleware for HTTP services

### 9.4 Logging

- Use structured logging with object context
- Include operation names and IDs in logs
- Use appropriate log levels
- Sanitize sensitive information before logging

## 10. Migration Guide

If you're migrating from custom utility functions to the standardized utilities:

1. Replace custom function wrappers with service wrappers:

   ```typescript
   // Old
   async function withErrorHandling(fn) {
     try {
       return await fn();
     } catch (error) {
       // Custom error handling
     }
   }

   // New
   const wrap = createServiceWrapper('my-service');

   async function myFunction(data) {
     return wrap({ operation: 'myFunction', dataId: data.id }, async () => {
       // Implementation
     });
   }
   ```

2. Replace custom context management with standardized context:

   ```typescript
   // Old
   const context = { requestId };
   await processWithContext(context);

   // New
   await withContext({ requestId }, async () => {
     await process();
   });
   ```

3. Replace custom metrics with standardized metrics:

   ```typescript
   // Old
   incrementCounter('my_service_counter');

   // New
   const metrics = createServiceMetrics('my-service');
   metrics.counter('counter');
   ```

4. Replace custom fetch wrappers with trackedFetch:

   ```typescript
   // Old
   async function callApi() {
     const start = Date.now();
     try {
       const response = await fetch(url);
       console.log(`API call took ${Date.now() - start}ms`);
       return response;
     } catch (error) {
       console.error('API call failed', error);
       throw error;
     }
   }

   // New
   const response = await trackedFetch(url, options, { operation: 'callApi' });
   ```
