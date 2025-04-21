# Error Handling Standards

This document outlines the standards and best practices for error handling in the Dome project.

## Error Hierarchy

The Dome project uses a consistent error hierarchy based on the `DomeError` class. All application-specific errors should extend this base class.

```typescript
import { DomeError, ValidationError, NotFoundError } from '@dome/errors';
```

### Base Error Class

`DomeError` is the base class for all application errors. It extends the standard JavaScript `Error` class and adds the following properties:

- `code`: A string identifier for the error type
- `statusCode`: HTTP status code associated with the error
- `details`: Optional object containing additional error details
- `cause`: Optional reference to an underlying error that caused this error

### Common Error Types

The following standard error types are provided:

| Error Class         | Code               | Status Code | Use Case                  |
| ------------------- | ------------------ | ----------- | ------------------------- |
| `ValidationError`   | `VALIDATION_ERROR` | 400         | Input validation failures |
| `NotFoundError`     | `NOT_FOUND`        | 404         | Resource not found        |
| `UnauthorizedError` | `UNAUTHORIZED`     | 401         | Authentication required   |
| `ForbiddenError`    | `FORBIDDEN`        | 403         | Permission denied         |
| `InternalError`     | `INTERNAL_ERROR`   | 500         | Unexpected server errors  |

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
```

### NotFoundError

Use `NotFoundError` when:

- A requested resource does not exist
- A database query returns no results when at least one was expected

Example:

```typescript
const user = await userRepository.findById(userId);
if (!user) {
  throw new NotFoundError(`User with ID ${userId} not found`);
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
```

### ForbiddenError

Use `ForbiddenError` when:

- User is authenticated but lacks permission for the requested action
- Access to a resource is restricted

Example:

```typescript
if (user.role !== 'admin') {
  throw new ForbiddenError('Admin access required');
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
  throw new InternalError('Database connection failed', {}, error);
}
```

## Error Handling Best Practices

### Throwing Errors

1. **Be specific**: Use the most specific error type that applies to the situation.
2. **Include meaningful messages**: Error messages should be clear and descriptive.
3. **Add context in details**: Use the `details` parameter to provide additional context.
4. **Chain errors**: Use the `cause` parameter to preserve the original error.

```typescript
try {
  await processData(input);
} catch (error) {
  throw new ValidationError(
    'Failed to process input data',
    { inputId: input.id },
    error instanceof Error ? error : undefined,
  );
}
```

### Catching and Handling Errors

1. **Handle errors at the appropriate level**: Catch errors where you can provide meaningful recovery or feedback.
2. **Don't swallow errors**: Always log or rethrow errors unless you have a good reason not to.
3. **Transform errors when crossing boundaries**: Convert internal errors to appropriate user-facing errors.

```typescript
try {
  return await userService.createUser(userData);
} catch (error) {
  if (error instanceof ValidationError) {
    // Pass validation errors through
    throw error;
  }

  // Log and transform other errors
  logger.error('User creation failed', { error, userData });
  throw new InternalError('Failed to create user');
}
```

### Error Middleware

The `@dome/errors` package provides an error handling middleware for Hono applications:

```typescript
import { errorHandler } from '@dome/errors';
import { Hono } from 'hono';

const app = new Hono();

// Apply error handling middleware
app.use('*', errorHandler());

// Define routes
app.get('/users/:id', async c => {
  const userId = c.req.param('id');
  const user = await userService.findById(userId);

  if (!user) {
    throw new NotFoundError(`User with ID ${userId} not found`);
  }

  return c.json({ user });
});
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

## Guidelines for Error Messages and Codes

### Error Messages

1. **Be specific but not revealing**: Provide enough information to understand the error without exposing sensitive details.
2. **Use plain language**: Write messages that are easy to understand.
3. **Be consistent**: Use a consistent tone and format across all error messages.
4. **Include actionable information**: When possible, suggest how to fix the error.

### Error Codes

1. **Use uppercase snake case**: All error codes should be in `UPPER_SNAKE_CASE`.
2. **Be descriptive**: Codes should indicate the type of error.
3. **Be consistent**: Use a consistent naming pattern.

## Testing Errors

When writing tests for error scenarios:

1. **Test error throwing**: Verify that functions throw the expected error types.
2. **Test error properties**: Check that error objects have the correct properties.
3. **Test error middleware**: Ensure the middleware handles errors correctly.

Example:

```typescript
it('should throw ValidationError for invalid input', async () => {
  const invalidData = { name: '' };

  await expect(userService.createUser(invalidData)).rejects.toThrow(ValidationError);

  try {
    await userService.createUser(invalidData);
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.statusCode).toBe(400);
    expect(error.details).toHaveProperty('field', 'name');
  }
});
```

## Migrating from Existing Error Handling

If you're working with code that uses the older error handling approach from the `@dome/common` package:

1. Replace `BaseError` with `DomeError`
2. Replace `status` property with `statusCode`
3. Update error constructors to use the new parameter structure
4. Replace `createErrorMiddleware` with `errorHandler`

## Conclusion

Consistent error handling improves the developer experience, makes debugging easier, and provides better feedback to API consumers. By following these standards, we ensure that errors throughout the Dome project are handled in a consistent and user-friendly way.
