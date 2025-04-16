# Migration Guide: Using @communicator/common

This document outlines the steps to migrate service-specific code to use the shared components from the `@communicator/common` package.

## Error Classes Migration

### Before

```typescript
// Importing from local error files
import {
  BaseError,
  ValidationError,
  ServiceError,
  QueueError,
  MessageProcessingError
} from './errors';
```

### After

```typescript
// Importing from common package
import {
  BaseError,
  ValidationError,
  ServiceError,
  QueueError,
  MessageProcessingError
} from '@communicator/common';
```

## Middleware Migration

### Before

```typescript
// Importing from local middleware files
import { pinoLogger } from "./middleware/pinoLogger";
import { createRequestContextMiddleware } from "./middleware/requestContext";
import { errorMiddleware } from "./middleware/errorMiddleware";
import { responseHandlerMiddleware } from "./middleware/responseHandlerMiddleware";

// Using middleware
app.use("*", createRequestContextMiddleware());
app.use("*", pinoLogger());
app.use("*", errorMiddleware);
app.use("*", responseHandlerMiddleware);
```

### After

```typescript
// Importing from common package
import { 
  createRequestContextMiddleware, 
  createErrorMiddleware, 
  responseHandlerMiddleware, 
  createPinoLoggerMiddleware 
} from "@communicator/common";

// Using middleware with factory functions
app.use("*", createRequestContextMiddleware());
app.use("*", createPinoLoggerMiddleware());
app.use("*", createErrorMiddleware(formatZodError));
app.use("*", responseHandlerMiddleware);
```

## Key Differences

1. **Factory Functions**: Most middleware components are now exposed as factory functions that allow for customization.
   
   Example:
   ```typescript
   // Before
   app.use("*", errorMiddleware);
   
   // After
   app.use("*", createErrorMiddleware(formatZodError));
   ```

2. **Consistent Error Handling**: All error classes follow a consistent pattern and are centrally maintained.

3. **Type Definitions**: Common types like `ApiResponse` and `ServiceInfo` are now imported from the common package.

## Cleanup

After migrating to the common package, you can remove the following directories and files:

- `src/errors/`
- `src/middleware/errorMiddleware.ts`
- `src/middleware/pinoLogger.ts`
- `src/middleware/requestContext.ts`
- `src/middleware/responseHandlerMiddleware.ts`
- `src/middleware/rateLimitMiddleware.ts` (if used)

## Benefits

1. **Consistency**: Ensures consistent error handling and response formatting across all services.
2. **Maintainability**: Centralizes common code to reduce duplication and make updates easier.
3. **Standardization**: Enforces standard patterns for error handling, logging, and API responses.
4. **Reduced Boilerplate**: New services can quickly implement standard middleware without duplicating code.

## Troubleshooting

If you encounter issues after migration:

1. **Type Errors**: Ensure you're using the correct types from the common package.
2. **Middleware Order**: Maintain the same middleware order as before.
3. **Custom Behavior**: If you had custom behavior in your middleware, use the configuration options provided by the factory functions.