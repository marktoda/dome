# Error Handling Standards

This document outlines the standards and best practices for error handling in the Dome project.

## Error Hierarchy

The Dome project uses a consistent error hierarchy based on the `DomeError` class. All application-specific errors should extend this base class.

```typescript
import {
  DomeError,
  ValidationError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  BadRequestError,
  InternalError,
  ConflictError,
  RateLimitError,
  ServiceUnavailableError,
} from '@dome/common/errors';
```

### Base Error Class

`DomeError` is the base class for all application errors. It extends the standard JavaScript `Error` class and adds the following properties:

- `code`: A string identifier for the error type
- `statusCode`: HTTP status code associated with the error
- `details`: Optional object containing additional error details
- `cause`: Optional reference to an underlying error that caused this error

### Common Error Types

The following standard error types are provided:

| Error Class               | Code                  | Status Code | Use Case                              |
| ------------------------- | --------------------- | ----------- | ------------------------------------- |
| `ValidationError`         | `VALIDATION_ERROR`    | 400         | Input validation failures             |
| `BadRequestError`         | `BAD_REQUEST`         | 400         | Malformed requests                    |
| `UnauthorizedError`       | `UNAUTHORIZED`        | 401         | Authentication required               |
| `ForbiddenError`          | `FORBIDDEN`           | 403         | Permission denied                     |
| `NotFoundError`           | `NOT_FOUND`           | 404         | Resource not found                    |
| `ConflictError`           | `CONFLICT`            | 409         | Resource conflicts (e.g., duplicates) |
| `RateLimitError`          | `RATE_LIMIT_EXCEEDED` | 429         | Rate limit exceeded                   |
| `InternalError`           | `INTERNAL_ERROR`      | 500         | Unexpected server errors              |
| `ServiceUnavailableError` | `SERVICE_UNAVAILABLE` | 503         | Service temporarily unavailable       |

## When to Use Each Error Type

### ValidationError

Use `ValidationError` when:

- User input fails validation rules
- Request parameters are invalid or missing
- Data format is incorrect

Example:

```typescript
if (!isValidEmail(email)) {
  throw new ValidationError('Invalid email format', { field: 'email' });
}

// With multiple validation errors
if (validationErrors.length > 0) {
  throw new ValidationError('Validation failed', { errors: validationErrors });
}
```

### BadRequestError

Use `BadRequestError` when:

- The request structure itself is malformed
- Missing required headers or query parameters
- Content-type issues

Example:

```typescript
if (!request.headers.get('content-type')?.includes('application/json')) {
  throw new BadRequestError('Content-Type must be application/json');
}
```

### NotFoundError

Use `NotFoundError` when:

- A requested resource does not exist
- A database query returns no results when at least one was expected

Example:

```typescript
const user = await userRepository.findById(userId);
if (!user) {
  throw new NotFoundError(`User with ID ${userId} not found`, { userId });
}
```

### UnauthorizedError

Use `UnauthorizedError` when:

- Authentication is required but not provided
- Authentication credentials are invalid
- Token has expired

Example:

```typescript
if (!authToken) {
  throw new UnauthorizedError('Authentication required');
}

if (isTokenExpired(authToken)) {
  throw new UnauthorizedError('Authentication token expired', { expiredAt: token.expiryTime });
}
```

### ForbiddenError

Use `ForbiddenError` when:

- User is authenticated but lacks permission for the requested action
- Access to a resource is restricted

Example:

```typescript
if (user.role !== 'admin' && resource.ownerId !== user.id) {
  throw new ForbiddenError('Insufficient permissions', {
    requiredRole: 'admin',
    userRole: user.role,
    resourceId: resource.id,
  });
}
```

### ConflictError

Use `ConflictError` when:

- An entity being created already exists
- A unique constraint is violated
- A concurrent update conflict occurs

Example:

```typescript
const existingUser = await userRepository.findByEmail(email);
if (existingUser) {
  throw new ConflictError('User with this email already exists', { email });
}
```

### RateLimitError

Use `RateLimitError` when:

- A user or client has exceeded their allowed request rate
- API usage quotas have been reached

Example:

```typescript
if (requestCount > RATE_LIMIT) {
  throw new RateLimitError('Rate limit exceeded', {
    limit: RATE_LIMIT,
    resetAt: new Date(Date.now() + RESET_PERIOD).toISOString(),
  });
}
```

### InternalError

Use `InternalError` when:

- An unexpected error occurs in the system
- A dependency fails unexpectedly
- You need to wrap a lower-level error

Example:

```typescript
try {
  await databaseService.connect();
} catch (error) {
  throw new InternalError(
    'Database connection failed',
    {
      operation: 'connect',
      database: DB_NAME,
    },
    error instanceof Error ? error : undefined,
  );
}
```

### ServiceUnavailableError

Use `ServiceUnavailableError` when:

- A service is temporarily unavailable (maintenance, overload)
- A required downstream service is not responding

Example:

```typescript
if (isMaintenanceMode) {
  throw new ServiceUnavailableError('Service is in maintenance mode', {
    estimatedResumption: maintenanceEndTime,
  });
}

if (!dependencyService.isAvailable()) {
  throw new ServiceUnavailableError('Dependency service unavailable', {
    dependency: 'payment-processor',
  });
}
```

## Error Handling Best Practices

### Throwing Errors

1. **Be specific**: Use the most specific error type that applies to the situation.
2. **Include meaningful messages**: Error messages should be clear and descriptive.
3. **Add context in details**: Use the `details` parameter to provide additional context.
4. **Chain errors**: Use the `cause` parameter to preserve the original error.
5. **Standardize codes**: Follow consistent code naming conventions.

```typescript
try {
  await processData(input);
} catch (error) {
  throw new ValidationError(
    'Failed to process input data',
    {
      inputId: input.id,
      operation: 'processData',
      step: 'validation',
    },
    error instanceof Error ? error : undefined,
  );
}
```

### Catching and Handling Errors

1. **Handle errors at the appropriate level**: Catch errors where you can provide meaningful recovery or feedback.
2. **Don't swallow errors**: Always log or rethrow errors unless you have a good reason not to.
3. **Transform errors when crossing boundaries**: Convert internal errors to appropriate user-facing errors.
4. **Use utility functions**: Leverage the error utilities for consistent handling.

```typescript
import { toDomeError, logError } from '@dome/common/errors';

try {
  return await userService.createUser(userData);
} catch (error) {
  // Log the error with context
  logError(error, 'User creation failed', { userData });

  // Convert to an appropriate DomeError if it's not already
  const domeError =
    error instanceof DomeError ? error : toDomeError(error, 'Failed to create user');

  if (domeError instanceof ValidationError) {
    // Pass validation errors through
    throw domeError;
  }

  // Don't expose internal details to users
  throw new InternalError('An error occurred while creating user');
}
```

### Using Error Utilities

The `@dome/common/errors` package provides several utilities to make error handling more consistent:

#### Error Conversion

```typescript
import { toDomeError } from '@dome/common/errors';

// Converts any error type to the most appropriate DomeError
const domeError = toDomeError(
  error,
  'Operation failed', // Default message
  { operation: 'processData' }, // Default details
);
```

#### Assertions

```typescript
import { assertValid, assertExists } from '@dome/common/errors';

// Throws ValidationError if false
assertValid(userId && userId.length > 0, 'User ID is required');

// Throws NotFoundError if null/undefined
const user = assertExists(await db.user.findById(userId), `User with ID ${userId} not found`);
```

#### Error Factory for Domains

```typescript
import { createErrorFactory } from '@dome/common/errors';

// Create domain-specific error factory
const userErrors = createErrorFactory('UserService', { component: 'user-management' });

// Use with consistent domain prefixing
throw userErrors.validation('Email is required', { field: 'email' });
throw userErrors.notFound(`User with ID ${userId} not found`);

// Use wrapped operations
return userErrors.wrap(() => updateUser(user), 'Failed to update user', { userId: user.id });
```

#### Database Error Handling

```typescript
import { handleDatabaseError } from '@dome/common/errors';

try {
  return await db.user.create({ data: userData });
} catch (dbError) {
  // Automatically converts DB-specific errors to appropriate DomeErrors
  throw handleDatabaseError(dbError, 'createUser', { userData });
}
```

### Error Middleware

The `@dome/common/errors` package provides an error handling middleware for Hono applications:

```typescript
import { errorHandler } from '@dome/common/errors';
import { Hono } from 'hono';

const app = new Hono();

// Basic error handler
app.use('*', errorHandler());

// With custom options
app.use(
  '*',
  errorHandler({
    includeStack: process.env.NODE_ENV !== 'production',
    includeCause: process.env.NODE_ENV !== 'production',
    errorMapper: err => {
      // Custom error mapping logic
      return err instanceof DomeError
        ? err
        : new InternalError('Internal server error', {}, err instanceof Error ? err : undefined);
    },
  }),
);
```

The middleware will:

1. Catch any errors thrown during request processing
2. Log the error with appropriate context
3. Convert the error to a standardized JSON response
4. Set the appropriate HTTP status code

## Error Response Format

All API errors are returned in a consistent format:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message",
    "details": {
      // Optional additional information
    }
  }
}
```

In development environments, additional debugging information may be included:

```json
{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "Database connection failed",
    "details": { "operation": "connect" },
    "stack": "Error: Database connection failed\n    at connectToDatabase (...)",
    "cause": "ECONNREFUSED 127.0.0.1:5432"
  }
}
```

## Guidelines for Error Messages and Codes

### Error Messages

1. **Be specific but not revealing**: Provide enough information to understand the error without exposing sensitive details.
2. **Use plain language**: Write messages that are easy to understand.
3. **Be consistent**: Use a consistent tone and format across all error messages.
4. **Include actionable information**: When possible, suggest how to fix the error.
5. **Follow the format**: `[Domain/Component] Specific error description`

### Error Codes

1. **Use uppercase snake case**: All error codes should be in `UPPER_SNAKE_CASE`.
2. **Be descriptive**: Codes should indicate the type of error.
3. **Be consistent**: Use a consistent naming pattern.

## Testing Errors

When writing tests for error scenarios:

1. **Test error throwing**: Verify that functions throw the expected error types.
2. **Test error properties**: Check that error objects have the correct properties.
3. **Test error middleware**: Ensure the middleware handles errors correctly.
4. **Test error utilities**: Verify that utility functions work as expected.

Example:

```typescript
it('should throw ValidationError for invalid input', async () => {
  const invalidData = { name: '' };

  // Test that the right error type is thrown
  await expect(userService.createUser(invalidData)).rejects.toThrow(ValidationError);

  // Test error properties in detail
  try {
    await userService.createUser(invalidData);
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.statusCode).toBe(400);
    expect(error.details).toHaveProperty('field', 'name');
  }
});

it('should convert unknown errors to DomeErrors', () => {
  const originalError = new Error('Database connection failed');

  const domeError = toDomeError(originalError, 'Operation failed');

  expect(domeError).toBeInstanceOf(InternalError);
  expect(domeError.message).toBe('Database connection failed');
  expect(domeError.cause).toBe(originalError);
});
```

## Common Error Scenarios

### Input Validation

```typescript
import { ValidationError } from '@dome/common/errors';

function validateUser(user) {
  const errors = [];

  if (!user.name) {
    errors.push({ field: 'name', message: 'Name is required' });
  }

  if (!user.email || !isValidEmail(user.email)) {
    errors.push({ field: 'email', message: 'Valid email is required' });
  }

  if (errors.length > 0) {
    throw new ValidationError('User validation failed', { errors });
  }

  return user;
}
```

### Resource Not Found

```typescript
import { NotFoundError } from '@dome/common/errors';

async function getUserById(id) {
  const user = await db.user.findUnique({ where: { id } });

  if (!user) {
    throw new NotFoundError(`User with ID ${id} not found`, { userId: id });
  }

  return user;
}
```

### Authorization Checks

```typescript
import { UnauthorizedError, ForbiddenError } from '@dome/common/errors';

function checkAccess(user, resource) {
  if (!user) {
    throw new UnauthorizedError('Authentication required');
  }

  if (resource.ownerId !== user.id && !user.roles.includes('admin')) {
    throw new ForbiddenError('Access denied', {
      resourceId: resource.id,
      requiredRoles: ['admin', 'owner'],
    });
  }
}
```

### External Service Calls

```typescript
import { ServiceUnavailableError, InternalError } from '@dome/common/errors';

async function callExternalAPI(endpoint, data) {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const text = await response.text();

      if (response.status === 503) {
        throw new ServiceUnavailableError('External service unavailable', {
          status: response.status,
          endpoint,
        });
      }

      throw new InternalError(`External API error: ${text}`, {
        status: response.status,
        endpoint,
      });
    }

    return await response.json();
  } catch (error) {
    if (error instanceof DomeError) throw error;

    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      throw new ServiceUnavailableError(
        'External service request timed out',
        {
          endpoint,
        },
        error,
      );
    }

    throw new InternalError('Failed to call external service', { endpoint }, error);
  }
}
```

## Conclusion

Consistent error handling improves the developer experience, makes debugging easier, and provides better feedback to API consumers. By following these standards, we ensure that errors throughout the Dome project are handled in a consistent and user-friendly way.

Always remember:

1. Use the most specific error type
2. Include meaningful context
3. Preserve error causes
4. Convert errors appropriately at boundaries
5. Return standardized error responses
6. Log detailed error information
7. Use the provided error utilities for consistency
