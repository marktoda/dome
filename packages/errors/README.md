# @dome/errors

A consistent error handling framework for the Dome project.

## Installation

```bash
pnpm add @dome/errors
```

## Usage

### Basic Usage

```typescript
import { DomeError, ValidationError, NotFoundError } from '@dome/errors';

// Throw a basic error
throw new DomeError('Something went wrong', {
  code: 'CUSTOM_ERROR',
  statusCode: 500,
});

// Throw a validation error
throw new ValidationError('Invalid input', { field: 'email' });

// Throw a not found error
throw new NotFoundError('User not found', { userId: '123' });
```

### Error Hierarchy

The package provides a hierarchy of error classes:

- `DomeError` - Base error class
  - `ValidationError` - For validation errors (400)
  - `NotFoundError` - For resource not found errors (404)
  - `UnauthorizedError` - For authentication errors (401)
  - `ForbiddenError` - For permission errors (403)
  - `InternalError` - For server errors (500)

### Error Properties

All errors have the following properties:

- `message` - Human-readable error message
- `code` - Error code (e.g., 'VALIDATION_ERROR')
- `statusCode` - HTTP status code
- `details` - Optional object with additional error details
- `cause` - Optional reference to an underlying error

### Error Middleware for Hono

The package includes a middleware for handling errors in Hono applications:

```typescript
import { errorHandler } from '@dome/errors';
import { Hono } from 'hono';

const app = new Hono();

// Apply error handling middleware
app.use('*', errorHandler());

// Define routes
app.get('/users/:id', async c => {
  const userId = c.req.param('id');

  if (!isValidId(userId)) {
    throw new ValidationError('Invalid user ID');
  }

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

### Error Response Format

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

## Best Practices

For detailed guidelines on error handling best practices, refer to the [Error Handling Standards](../../docs/standards/error-handling.md) documentation.

## License

UNLICENSED
