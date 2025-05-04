# Error Handling Architecture

> **Version:** 1.0.0  
> **Package:** `@dome/common`  
> **Stack:** TypeScript 5 · Hono v4

## 1. Overview

The Dome platform implements a comprehensive error handling architecture that provides consistent error management across all services. This document outlines the standardized approach to error handling, including error hierarchies, middleware, and best practices.

The error handling system is designed to:

- Provide a consistent error hierarchy with appropriate HTTP status codes
- Enable rich contextual information for debugging
- Ensure consistent error responses across all APIs
- Facilitate error tracking and monitoring
- Simplify error handling for developers

## 2. Error Hierarchy

### 2.1 Base Error Class

All application errors extend from the `BaseError` class, which provides common functionality:

```typescript
export class BaseError extends Error {
  code: string;
  status: number;
  details?: Record<string, any>;

  constructor(message: string, code: string, status = 500, details?: Record<string, any>) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    this.details = details;

    // Maintains proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}
```

### 2.2 Error Types

The error hierarchy includes specialized error types for different scenarios:

#### Service Errors

- `ServiceError`: Base class for service-related errors (500)
- `QueueError`: Errors related to queue operations (500)
- `MessageProcessingError`: Errors in message processing (500)
- `RateLimitError`: Rate limiting errors (429)
- `NotFoundError`: Resource not found errors (404)
- `UnauthorizedError`: Authentication errors (401)
- `ForbiddenError`: Authorization errors (403)
- `NotImplementedError`: Feature not implemented errors (501)

#### Validation Errors

- `ValidationError`: Base class for validation errors (400)
- `SchemaValidationError`: Schema validation failures (400)
- `MessageFormatError`: Message format errors (400)
- `BatchValidationError`: Batch validation errors (400)

## 3. Error Middleware

The error handling middleware provides a consistent way to handle errors in Hono applications:

```typescript
import { createErrorMiddleware } from '@dome/common';

// In your application setup
app.use('*', createErrorMiddleware());
```

The middleware:

1. Catches all errors thrown during request processing
2. Converts errors to the appropriate type
3. Formats error responses consistently
4. Handles sensitive information appropriately based on environment
5. Logs errors with contextual information

### 3.1 Error Response Format

All API error responses follow a consistent format:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message",
    "requestId": "unique-request-id",
    "details": {
      // Optional additional context about the error
    }
  }
}
```

## 4. Error Utilities

### 4.1 Error Creation

Create appropriate error types for different scenarios:

```typescript
// Basic error creation
throw new ServiceError('Database connection failed');

// With additional context
throw new ValidationError('Invalid email format', { field: 'email', value: input.email });

// Not found error
throw new NotFoundError(`User with ID ${userId} not found`);

// Authentication error
throw new UnauthorizedError('Invalid credentials');
```

### 4.2 Error Conversion

Convert unknown errors to appropriate typed errors:

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

### 4.3 Validation Helpers

Simplify validation with assertion helpers:

```typescript
import { createEnhancedAssertValid } from '@dome/common';

const assertValid = createEnhancedAssertValid();

// Assert a condition is true
assertValid(user.isActive, 'User account is not active', { userId: user.id });

// Assert an entity exists
assertValid(!!user, 'User not found', { userId: requestedId });
```

## 5. Function Wrappers

### 5.1 Service Wrapper

Wrap service functions with consistent error handling:

```typescript
import { createServiceWrapper } from '@dome/common';

// Create a service-specific wrapper
const wrap = createServiceWrapper('auth-service');

// Use the wrapper for service functions
async function authenticateUser(credentials) {
  return wrap({ operation: 'authenticateUser', userId: credentials.userId }, async () => {
    // Implementation with automatic error handling
    // Any errors will be properly converted, logged, and rethrown
  });
}
```

### 5.2 Process Chain

Break down complex operations with proper error handling at each step:

```typescript
import { createProcessChain } from '@dome/common';

const processUserRegistration = createProcessChain({
  serviceName: 'user-service',
  operation: 'registerUser',

  // Input validation step
  inputValidation: input => {
    assertValid(input.email, 'Email is required');
    assertValid(input.password, 'Password is required');
  },

  // Main processing step
  process: async input => {
    // Implementation with automatic error handling
    return createdUser;
  },

  // Output validation step
  outputValidation: output => {
    assertValid(output.id, 'User ID is missing in the result');
  },
});

// Use the process chain
const user = await processUserRegistration(registrationData);
```

## 6. Integration with Logging

The error handling system integrates seamlessly with the logging system:

```typescript
import { logError } from '@dome/common';

try {
  // Operation
} catch (error) {
  // Log the error with rich context
  logError(error, 'Failed to process request', { requestId, userId });

  // Rethrow or handle as appropriate
  throw error;
}
```

## 7. Best Practices

### 7.1 Use Specific Error Types

Always use the most specific error type for the situation:

```typescript
// GOOD
throw new NotFoundError(`User with ID ${userId} not found`);

// AVOID
throw new Error(`User with ID ${userId} not found`);
```

### 7.2 Include Contextual Information

Always include relevant context in error details:

```typescript
// GOOD
throw new ValidationError('Invalid email format', {
  field: 'email',
  value: input.email,
  validationRule: 'email',
});

// AVOID
throw new ValidationError('Invalid email format');
```

### 7.3 Chain Errors to Preserve Causes

Preserve the original error when wrapping:

```typescript
try {
  await db.query(sql);
} catch (error) {
  // Include the original error as the cause
  throw new ServiceError('Database query failed', { operation: 'getUserProfile' }, error);
}
```

### 7.4 Use Error Middleware

Always use the error middleware in HTTP services:

```typescript
import { Hono } from 'hono';
import { initLogging, createErrorMiddleware } from '@dome/common';

const app = new Hono();
initLogging(app);

// Apply error handling middleware
app.use('*', createErrorMiddleware());

// Routes here...

export default app;
```

### 7.5 Handle Errors at Service Boundaries

Always handle and convert errors at service boundaries:

```typescript
// When calling another service
try {
  const result = await otherService.operation();
  return result;
} catch (error) {
  // Convert to an appropriate error for this service
  throw toDomeError(error, 'Failed to perform operation', { context });
}
```

## 8. Migration Guide

If you're migrating from the old error handling approach:

1. Replace generic Error instances with specific error types:

   ```typescript
   // Old
   throw new Error('User not found');

   // New
   throw new NotFoundError(`User with ID ${userId} not found`);
   ```

2. Add error middleware to your application:

   ```typescript
   // Add to your application setup
   app.use('*', createErrorMiddleware());
   ```

3. Replace custom error handling with standardized utilities:

   ```typescript
   // Old
   try {
     // operation
   } catch (error) {
     console.error('Error:', error);
     return c.json({ error: 'An error occurred' }, 500);
   }

   // New
   // The middleware will handle errors automatically
   // Just throw the appropriate error type
   throw new ServiceError('Operation failed', { details });
   ```

4. Use function wrappers for service operations:

   ```typescript
   // Old
   async function processData(data) {
     try {
       // implementation
     } catch (error) {
       // custom error handling
     }
   }

   // New
   const wrap = createServiceWrapper('data-service');

   async function processData(data) {
     return wrap({ operation: 'processData', dataId: data.id }, async () => {
       // implementation with automatic error handling
     });
   }
   ```

## 9. Verification

The repository includes verification scripts to ensure compliance with the error handling standards:

- `scripts/verify-logging-errors.js`: Verifies that all services are using the standardized error handling approach
- `scripts/remove-redundant-error-extractions.js`: Helps clean up redundant error handling code

Run these scripts regularly to ensure your codebase maintains consistent error handling practices.
