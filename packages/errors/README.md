# @dome/errors

A comprehensive error handling framework for the Dome project that provides consistent error types, standardized error responses, and powerful utilities for error management.

## Installation

```bash
pnpm add @dome/errors
```

## Features

- Standardized error hierarchy with appropriate HTTP status codes
- Detailed error context and cause chaining
- JSON serialization for logging and API responses
- Hono middleware for centralized error handling
- Utilities for error conversion, validation, and assertions
- Factory methods for domain-specific error handling

## Usage

### Error Hierarchy

```typescript
import { 
  DomeError,             // Base error class (500)
  ValidationError,       // Input validation errors (400)
  NotFoundError,         // Resource not found (404)
  UnauthorizedError,     // Authentication required (401)
  ForbiddenError,        // Permission denied (403)
  BadRequestError,       // Malformed request (400)
  InternalError,         // Server error (500)
  ConflictError,         // Resource conflict (409)
  RateLimitError,        // Rate limit exceeded (429)
  ServiceUnavailableError // Service unavailable (503)
} from '@dome/errors';
```

### Basic Error Usage

```typescript
// Base error with custom code and status
throw new DomeError('Something went wrong', {
  code: 'CUSTOM_ERROR',
  statusCode: 500,
  details: { operationId: '123' }
});

// Specific error types
throw new ValidationError('Invalid email format', { field: 'email' });
throw new NotFoundError('User not found', { userId: '123' });
throw new ForbiddenError('Admin access required', { requiredRole: 'admin' });
```

### Error with Cause Chaining

```typescript
try {
  await db.query('SELECT * FROM users');
} catch (dbError) {
  throw new InternalError(
    'Database query failed', 
    { operation: 'fetchUsers' }, 
    dbError
  );
}
```

### Adding Context to Errors

```typescript
// Add context when creating the error
throw new ValidationError('Invalid input', { 
  field: 'email',
  value: input.email, 
  validationRule: 'email'
});

// Or add context to an existing error
try {
  // some operation
} catch (error) {
  if (error instanceof DomeError) {
    throw error.withContext({ requestId, timestamp: Date.now() });
  }
  throw error;
}
```

### Error Handler Middleware for Hono

```typescript
import { errorHandler } from '@dome/errors';
import { Hono } from 'hono';

const app = new Hono();

// Basic error handler
app.use('*', errorHandler());

// Advanced configuration
app.use('*', errorHandler({
  includeStack: true, // Include stack traces in non-production
  includeCause: true, // Include cause in non-production
  // Custom error mapper
  errorMapper: (err) => {
    if (err instanceof CustomDBError) {
      return new InternalError('Database error', { 
        dbErrorCode: err.code 
      }, err);
    }
    // Default mapping for other errors
    return err instanceof DomeError 
      ? err 
      : new InternalError('Unexpected error', {}, err instanceof Error ? err : undefined);
  },
  // Custom logger retrieval
  getContextLogger: (c) => c.get('customLogger')
}));
```

### Error Utilities

#### Converting Unknown Errors

```typescript
import { toDomeError } from '@dome/errors';

try {
  // Code that might throw any type of error
} catch (error) {
  // Convert to appropriate DomeError
  const domeError = toDomeError(
    error,
    'Operation failed', // Default message
    { operation: 'processData' } // Default details
  );
  
  // Now it's a properly typed DomeError
  console.log(domeError.statusCode); // 400, 404, 500, etc.
  console.log(domeError.code); // "VALIDATION_ERROR", "NOT_FOUND", etc.
}
```

#### Validation Assertions

```typescript
import { assertValid, assertExists } from '@dome/errors';

function processUser(userId?: string) {
  // Throws ValidationError if false
  assertValid(userId && userId.length > 0, 'User ID is required');
  
  const user = userRepository.findById(userId);
  
  // Throws NotFoundError if null or undefined
  return assertExists(user, `User with ID ${userId} not found`);
}
```

#### Database Error Handling

```typescript
import { handleDatabaseError } from '@dome/errors';

async function getUser(id: string) {
  try {
    return await db.user.findUnique({ where: { id } });
  } catch (error) {
    // Converts DB errors to appropriate DomeErrors:
    // - NotFoundError for "not found" errors
    // - ConflictError for unique constraint violations
    // - ValidationError for foreign key constraint errors
    // - InternalError for other database errors
    throw handleDatabaseError(error, 'getUser', { userId: id });
  }
}
```

#### Domain-Specific Error Factory

```typescript
import { createErrorFactory } from '@dome/errors';

// Create error factory for a specific domain
const userErrors = createErrorFactory('UserService', { component: 'user-management' });

function validateUser(user) {
  // Domain-specific validation error
  if (!user.email) {
    throw userErrors.validation('Email is required', { field: 'email' });
  }
  
  // Domain-specific not found error
  const dbUser = findUserByEmail(user.email);
  if (!dbUser) {
    throw userErrors.notFound(`User with email ${user.email} not found`);
  }
  
  // Domain-specific assertion
  userErrors.assertValid(user.password.length >= 8, 
    'Password must be at least 8 characters',
    { field: 'password' }
  );
  
  // Domain-specific error wrapper
  return userErrors.wrap(
    () => updateUser(user),
    'Failed to update user',
    { userId: user.id }
  );
}
```

### Custom Handling in Catch Blocks

```typescript
import { DomeError, ValidationError, NotFoundError } from '@dome/errors';

try {
  await userService.updateUser(userId, userData);
} catch (error) {
  if (error instanceof ValidationError) {
    // Handle validation errors
    return c.json({ message: 'Please check your input', fields: error.details }, 400);
  } else if (error instanceof NotFoundError) {
    // Handle not found errors
    return c.json({ message: error.message }, 404);
  } else if (error instanceof DomeError) {
    // Handle other known errors
    return c.json({ message: 'Operation failed', code: error.code }, error.statusCode);
  } else {
    // Handle unknown errors
    console.error('Unexpected error:', error);
    return c.json({ message: 'An unexpected error occurred' }, 500);
  }
}
```

### Error Response Format

All API errors are returned in a consistent format:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid email format",
    "details": {
      "field": "email",
      "value": "invalid-email"
    }
  }
}
```

## Best Practices

### Error Creation

1. **Use specific error types** that match the error condition
2. **Include meaningful messages** that explain what went wrong
3. **Add contextual details** to help with debugging
4. **Chain error causes** to preserve the original error information

```typescript
// Good
throw new ValidationError(
  'Invalid date range', 
  { 
    startDate: request.startDate,
    endDate: request.endDate,
    rule: 'start_date_before_end_date'
  }
);

// Avoid
throw new Error('Invalid dates');
```

### Error Handling

1. **Handle errors at appropriate levels** - catch and handle errors where you have enough context
2. **Transform technical errors** to user-friendly errors at API boundaries
3. **Add context when rethrowing** - include operation info and request details
4. **Log detailed errors** but return sanitized responses to users

```typescript
try {
  return await userService.createUser(userData);
} catch (error) {
  logger.error({ error, userData }, 'User creation failed');
  
  if (error instanceof ValidationError) {
    // Pass validation errors through to API
    throw error;
  }
  
  // Hide internal errors from users
  throw new InternalError('Unable to create user at this time');
}
```

For more detailed guidelines on error handling, refer to the [Error Handling Standards](../../docs/standards/error-handling.md) documentation.
