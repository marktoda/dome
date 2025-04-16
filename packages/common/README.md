# @communicator/common

This package contains common utilities, error types, and middleware components shared across the Communicator microservices architecture.

## Installation

```bash
pnpm add @communicator/common
```

## Features

### Error Handling

The package provides a standardized error hierarchy for consistent error handling across services:

- `BaseError`: Base error class for all application errors
- `ValidationError`: For validation-related errors
  - `SchemaValidationError`: For schema validation errors
  - `MessageFormatError`: For message format validation errors
  - `BatchValidationError`: For batch validation errors
- `ServiceError`: For service-related errors
  - `QueueError`: For queue-related errors
  - `MessageProcessingError`: For message processing errors
  - `RateLimitError`: For rate limit errors
  - `NotFoundError`: For resource not found errors

Example usage:

```typescript
import { ValidationError } from '@communicator/common';

throw new ValidationError('Invalid input', { field: 'email' });
```

### Middleware Components

The package provides reusable middleware components for Hono-based services:

- `createRequestContextMiddleware`: Adds request ID tracking
- `createErrorMiddleware`: Standardized error handling
- `responseHandlerMiddleware`: Standardized response formatting
- `createPinoLoggerMiddleware`: Request logging with Pino
- `createRateLimitMiddleware`: Rate limiting

Example usage:

```typescript
import { 
  createRequestContextMiddleware, 
  createErrorMiddleware, 
  responseHandlerMiddleware 
} from '@communicator/common';

// In your Hono app setup
app.use("*", createRequestContextMiddleware());
app.use("*", createErrorMiddleware(formatZodError));
app.use("*", responseHandlerMiddleware);
```

### Types

The package provides common types used across services:

- `ApiResponse`: Standardized API response format
- `ServiceInfo`: Service information format
- `ExtendedError`: Extended error interface

## Migration Guide

When migrating from service-specific implementations to the common package:

1. Replace imports from local error files with imports from `@communicator/common`
2. Replace middleware imports with the factory functions from `@communicator/common`
3. Update any service-specific customizations to use the configuration options provided by the middleware factory functions

## Development

To build the package:

```bash
cd packages/common
pnpm build
```

To run tests:

```bash
cd packages/common
pnpm test