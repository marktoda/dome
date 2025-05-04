# Logging and Error Handling Analysis

This document provides a comprehensive analysis of the current logging and error handling implementation across the Dome repository, with recommendations for best practices and improvements.

## 1. Logging Architecture

### Core Components

The `packages/logging` package provides a structured, context-aware logging system built on the following components:

1. **Base Logger**

   - Built on the Pino logging library
   - Configured specifically for Cloudflare Workers environment
   - Outputs structured JSON logs that can be processed by Logpush
   - Created once as a singleton to optimize performance

2. **Context Propagation**

   - Uses AsyncLocalStorage (ALS) to maintain context across asynchronous operations
   - Request-scoped logging context is maintained throughout the request lifecycle
   - `getLogger()` retrieves the current logger from ALS or falls back to the base logger
   - `withLogger()` creates a new logging context for a specific operation

3. **Hono Integration**

   - `loggerMiddleware()` provides seamless integration with the Hono web framework
   - `buildLoggingMiddleware()` creates middleware that adds request-scoped logging
   - `initLogging(app, opts)` configures both Hono's context storage and ALS-based logging
   - Requires `nodejs_als` or `nodejs_compat` compatibility flag in Cloudflare Workers

4. **Metrics Collection**
   - `MetricsService` class for tracking performance and operational metrics
   - `createServiceMetrics(serviceName)` creates a service-specific metrics instance
   - Supports counter, gauge, timing, and operation tracking metric types
   - Metrics are logged as structured logs for processing by monitoring systems

### Logger Instantiation and Configuration

```typescript
// Creating a service logger
const logger = createLogger({
  service: 'silo',
  component: 'contentController',
  version: '1.0.0',
  environment: 'production',
});

// Retrieving the current context logger
const logger = getLogger();

// Setting up logging middleware in a Hono app
initLogging(app, {
  idFactory: () => nanoid(12),
  extraBindings: { apiVersion: '2.0' },
});
```

### Available Logging Methods

| Method       | Purpose                                                 | Example                                                 |
| ------------ | ------------------------------------------------------- | ------------------------------------------------------- |
| `info()`     | Normal operational information                          | `logger.info({ id, status }, 'Request processed')`      |
| `error()`    | Error conditions                                        | `logger.error({ error }, 'Database connection failed')` |
| `warn()`     | Potentially harmful situations                          | `logger.warn({ key }, 'Deprecated method called')`      |
| `debug()`    | Detailed information for debugging                      | `logger.debug({ config }, 'Service configured')`        |
| `trace()`    | Extremely detailed information (disabled in production) | `logger.trace({ state }, 'Process state updated')`      |
| `logError()` | Enhanced error logging with extraction                  | `logError(error, 'Failed to process data', { dataId })` |

## 2. Error Handling Architecture

### Error Hierarchy

The `packages/errors` package defines a consistent error hierarchy for the application:

```
DomeError (base class)
├── ValidationError (400)
├── NotFoundError (404)
├── UnauthorizedError (401)
├── ForbiddenError (403)
├── BadRequestError (400)
└── InternalError (500)
```

Each error type includes:

- `code`: String identifier (e.g., "VALIDATION_ERROR")
- `statusCode`: HTTP status code
- `details`: Optional additional context
- `cause`: Optional underlying error (for error chaining)

### Error Middleware

The package provides an error handling middleware for Hono applications:

```typescript
// Apply error handling middleware
app.use('*', errorHandler());
```

This middleware:

1. Catches any errors thrown during request processing
2. Converts errors to the appropriate DomeError type
3. Logs errors with contextual information
4. Returns a standardized error response format

### Error Response Format

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

## 3. Analysis of Current Implementation

### Strengths

1. **Structured Logging**

   - Consistent JSON format enables parsing and analysis
   - Context propagation provides request tracing
   - Integration with Hono simplifies implementation

2. **Comprehensive Error Hierarchy**

   - Clear separation of error types by HTTP status codes
   - Error chaining preserves root causes
   - Standardized response format improves API consistency

3. **Performance Monitoring**

   - Built-in metrics collection
   - Operation timing and tracking
   - Success/failure metrics for operations

4. **Request Lifecycle Tracking**
   - Automatic logging of request start/end events
   - Duration tracking for performance monitoring
   - Request ID propagation for distributed tracing

### Observed Implementation Patterns

From examining service implementations like `ContentController`, I observe:

1. **Logger Acquisition**

   ```typescript
   const logger = getLogger();
   ```

2. **Structured Log Entries**

   ```typescript
   logger.info({ id, category, mimeType, size }, 'Content stored successfully');
   ```

3. **Error Handling with logError**

   ```typescript
   logError(error, 'Error processing R2 event', { event });
   ```

4. **Performance Tracking**

   ```typescript
   const start = performance.now();
   try {
     // operation
   } finally {
     metrics.timing('silo.rpc.simplePut.latency_ms', performance.now() - start);
   }
   ```

5. **Operation Success/Failure Tracking**
   ```typescript
   metrics.increment('silo.r2.events.processed');
   // or on error
   metrics.increment('silo.r2.events.errors');
   ```

## 4. Identified Inconsistencies and Improvement Areas

1. **Inconsistent Error Types**

   - Some code uses generic `Error` instead of the `DomeError` hierarchy
   - Example: `throw new Error('User ID is required')` instead of `throw new ValidationError('User ID is required')`

2. **Incomplete Error Context**

   - Some errors lack detailed context in the `details` property
   - Better contextual information would aid debugging

3. **Variable Log Level Usage**

   - Inconsistent use of log levels across services
   - Some debug information is logged at info level

4. **Error Handling in Catch Blocks**

   - Some catch blocks rethrow errors after logging them
   - Others swallow errors and return default values

5. **Request ID Propagation**

   - Not all services consistently propagate request IDs in external service calls

6. **Metrics Naming Consistency**
   - Varying patterns for metric names (`silo.upload.bytes` vs `silo.rpc.simplePut.latency_ms`)

## 5. Best Practices Recommendations

### For Logging

1. **Use Structured Logging Consistently**

   ```typescript
   // GOOD
   logger.info({ userId, operation: 'createUser', duration }, 'User created successfully');

   // AVOID
   logger.info(`User ${userId} created successfully in ${duration}ms`);
   ```

2. **Use Appropriate Log Levels**

   - `error`: Only for errors that impact functionality
   - `warn`: For issues that don't prevent operation but require attention
   - `info`: For normal operational information
   - `debug`: For detailed information useful for debugging (disable in production)

3. **Include Contextual Information**

   - Always include relevant IDs (request ID, user ID, content ID)
   - Include operation-specific context (query parameters, categories)
   - Log operation start/end with duration for performance tracking

4. **Standardize Event Names**

   - Use consistent event naming: `request_start`, `request_end`, `operation_failed`
   - Include event name in the context object: `{ event: 'user_created', userId }`

5. **Avoid Excessive Logging**
   - Don't log entire request/response bodies
   - Don't log sensitive information (PII, credentials)
   - Use sampling for high-volume events

### For Error Handling

1. **Use Specific Error Types**

   ```typescript
   // GOOD
   throw new ValidationError('Invalid email format', { field: 'email' });

   // AVOID
   throw new Error('Invalid email format');
   ```

2. **Include Detailed Context**

   ```typescript
   throw new NotFoundError(`User with ID ${userId} not found`, {
     entity: 'User',
     id: userId,
     query: { email, role },
   });
   ```

3. **Chain Errors to Preserve Causes**

   ```typescript
   try {
     await db.query(sql);
   } catch (error) {
     throw new InternalError('Database query failed', { operation: 'getUserProfile' }, error);
   }
   ```

4. **Use logError Consistently**

   ```typescript
   try {
     // operation
   } catch (error) {
     logError(error, 'Failed to process request', { requestId, userId });
     throw error; // or handle it
   }
   ```

5. **Handle Errors at Appropriate Level**
   - Don't swallow errors unless you can fully recover
   - Transform technical errors to user-friendly errors at API boundaries
   - Log detailed technical errors but return simplified messages to users

## 6. Implementation Recommendations

1. **Standardize Error Usage**

   - Update all code to use the DomeError hierarchy
   - Create script to find and replace generic Error instances

2. **Enhance Logging Middleware**

   - Add request body size and type to request logs
   - Include more Cloudflare-specific information (country, browser)

3. **Improve Error Details**

   - Add more context to error details objects
   - Include troubleshooting hints in error messages

4. **Standardize Metrics**

   - Create a metrics naming convention document
   - Implement consistent tagging strategy

5. **Error Monitoring Integration**

   - Add integration with error monitoring services
   - Group similar errors for better analysis

6. **Log Sampling**
   - Implement sampling for high-volume debug logs
   - Keep 100% of error and warning logs

By implementing these recommendations, the Dome project can achieve more consistent, informative, and actionable logging and error handling across all services.
