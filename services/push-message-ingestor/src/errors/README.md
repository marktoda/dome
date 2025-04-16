# Error Handling System

This directory contains the error handling system for the push-message-ingestor service. It provides a structured approach to error handling with a hierarchy of error classes and utility functions.

## Error Hierarchy

The error system is organized as a hierarchy of error classes:

```
BaseError
├── ValidationError
│   ├── SchemaValidationError
│   ├── MessageFormatError
│   └── BatchValidationError
└── ServiceError
    ├── QueueError
    ├── MessageProcessingError
    ├── RateLimitError
    └── NotFoundError
```

## Error Classes

### BaseError

The base class for all application errors. It extends the standard JavaScript `Error` class and adds:
- `code`: A string code identifying the error type
- `status`: HTTP status code to return
- `details`: Optional object with additional error details

### ValidationError (400 Bad Request)

Base class for validation-related errors.

#### SchemaValidationError

For errors related to schema validation (e.g., Zod validation failures).

#### MessageFormatError

For errors related to message format validation.

#### BatchValidationError

For errors related to batch validation.

### ServiceError (500 Internal Server Error)

Base class for service-related errors.

#### QueueError

For errors related to queue operations.

#### MessageProcessingError

For errors related to message processing.

#### RateLimitError (429 Too Many Requests)

For rate limiting errors.

#### NotFoundError (404 Not Found)

For resource not found errors.

## Usage

### Creating Errors

You can create errors using the error classes directly:

```typescript
throw new ValidationError('Invalid input', { field: 'username' });
```

Or using the utility functions:

```typescript
throw createValidationError('Invalid input', { field: 'username' });
```

### Error Handling

The error middleware (`errorMiddleware.ts`) catches all errors and formats them into standardized API responses. It handles:

1. Custom application errors (instances of `BaseError`)
2. Zod validation errors
3. Unknown errors

## Best Practices

1. **Use Specific Error Types**: Use the most specific error type for the situation.
2. **Include Helpful Details**: Add relevant details to help with debugging.
3. **Consistent Error Codes**: Use consistent error codes across the application.
4. **Handle Errors at the Right Level**: Catch and handle errors at the appropriate level of abstraction.
5. **Log Errors**: Ensure errors are properly logged for monitoring and debugging.

## Example

```typescript
try {
  // Some operation that might fail
  await processMessage(message);
} catch (error) {
  if (error instanceof ValidationError) {
    // Handle validation errors
    logger.warn('Validation error', { error });
    throw error;
  } else if (error instanceof QueueError) {
    // Handle queue errors
    logger.error('Queue error', { error });
    throw error;
  } else {
    // Handle unknown errors
    logger.error('Unknown error', { error });
    throw new ServiceError('An unexpected error occurred');
  }
}