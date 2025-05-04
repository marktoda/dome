# Dome Logging System

> **Version:** 1.0.0
> **Runtime:** Cloudflare Workers (HTTP, Cron, Queue)
> **Stack:** TypeScript 5 · Hono v4 · Pino v8

## 1. Overview

The Dome logging system provides a structured, context-aware logging framework that ensures consistent logging patterns across all services. It has been refactored to centralize logging functionality in the `@dome/common` package, making it easier to maintain and extend.

```ts
// Initialize logging in your application
import { initLogging } from '@dome/common';
const app = new Hono();
initLogging(app);

// Use the logger anywhere in your code
import { getLogger } from '@dome/common';
getLogger().info({ userId, operation: 'createUser' }, 'User created successfully');
```

## 2. Key Features

- **Structured Logging**: All logs are structured JSON objects with consistent fields
- **Context Propagation**: Request context is automatically propagated through AsyncLocalStorage
- **Request Tracking**: Automatic logging of request start/end events with duration metrics
- **Operation Tracking**: Specialized helpers for tracking operations with timing and success/failure metrics
- **Error Extraction**: Automatic extraction of detailed error information
- **Sensitive Data Handling**: Automatic redaction of sensitive information
- **Service Metrics**: Standardized metrics collection for monitoring and alerting

## 3. Core Components

### 3.1 Base Logger

The base logger is built on Pino and configured for the Cloudflare Workers environment:

```ts
// src/logging/base.ts
export const baseLogger = pino({
  level: (globalThis as any).LOG_LEVEL ?? 'info',
  browser: {
    asObject: true,
    write: obj => console.log(obj), // Workers picks this up for Logpush
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});
```

### 3.2 Context-Aware Logging

The logging system uses AsyncLocalStorage to maintain context across asynchronous operations:

```ts
// Get the context-aware logger
const logger = getLogger();

// Log with structured context
logger.info({ userId, operation: 'createUser' }, 'User created successfully');
```

### 3.3 Error Logging

Enhanced error logging automatically extracts and includes detailed error information:

```ts
import { logError } from '@dome/common';

try {
  // Operation code
} catch (error) {
  logError(error, 'Failed to process request', { requestId, userId });
  throw error; // or handle it
}
```

### 3.4 Operation Tracking

Track operations with automatic timing and success/failure metrics:

```ts
import { trackOperation } from '@dome/common';

const result = await trackOperation('userAuthentication', async () => {
  // Operation code here
  return result;
});
```

## 4. Standardized Log Levels

The logging system uses the following standardized log levels:

| Level | Usage |
|-------|-------|
| `error` | Only for errors that impact functionality |
| `warn` | For issues that don't prevent operation but require attention |
| `info` | For normal operational information |
| `debug` | For detailed information useful for debugging (disable in production) |
| `trace` | For very detailed tracing information (rarely used) |

## 5. Utility Functions

### 5.1 Error Logging

```ts
// Log an error with context
logError(error, 'Failed to process request', { requestId, userId });

// Create a context-bound error logger
const errorLogger = createErrorLogger({ service: 'auth' });
errorLogger(error, 'Authentication failed', { userId });
```

### 5.2 Operation Tracking

```ts
// Track an operation with timing
await trackOperation('processMessage', async () => {
  // Operation code
});

// Log operation stages manually
logOperationStart('processMessage', { messageId });
// ... operation code
logOperationSuccess('processMessage', duration, { messageId });
// or if it fails
logOperationFailure('processMessage', error, { messageId });
```

### 5.3 External API Calls

```ts
// Track external API calls with standardized logging
const response = await trackedFetch('https://api.example.com/data', {
  method: 'POST',
  body: JSON.stringify(data)
}, { operation: 'fetchExternalData' });
```

### 5.4 Sanitization

```ts
// Sanitize sensitive data before logging
const sanitizedData = sanitizeForLogging(userData);
logger.info({ user: sanitizedData }, 'User data processed');
```

## 6. Service Integration

### 6.1 HTTP API Worker

```ts
import { Hono } from 'hono';
import { initLogging, getLogger, createErrorMiddleware } from '@dome/common';

const app = new Hono();

// Initialize logging
initLogging(app, {
  extraBindings: { service: 'api', version: '1.0.0' }
});

// Add error handling middleware
app.use('*', createErrorMiddleware());

app.get('/users/:id', async c => {
  const logger = getLogger();
  logger.info({ params: c.req.param() }, 'Fetching user');
  
  // Rest of handler code
});

export default app;
```

### 6.2 Queue Consumer Worker

```ts
import { runWithLogger, getLogger } from '@dome/common';

export default {
  async queue(batch, env, ctx) {
    await runWithLogger(
      { trigger: 'queue', batch: batch.length },
      async () => {
        getLogger().info('Processing batch');
        // ...process
      },
      ctx,
    );
  },
};
```

## 7. Best Practices

### 7.1 Use Structured Logging

Always use structured logging with object context:

```ts
// GOOD
logger.info({ userId, operation: 'createUser', duration }, 'User created successfully');

// AVOID
logger.info(`User ${userId} created successfully in ${duration}ms`);
```

### 7.2 Use Appropriate Log Levels

Use the correct log level for different types of information:

```ts
// Error: Only for errors that impact functionality
logger.error({ err }, 'Database connection failed');

// Warning: For issues that don't prevent operation but require attention
logger.warn({ queueSize }, 'Queue size exceeding threshold');

// Info: For normal operational information
logger.info({ userId }, 'User logged in successfully');

// Debug: For detailed information useful for debugging
logger.debug({ query }, 'Executing database query');
```

### 7.3 Include Contextual Information

Always include relevant context with your logs:

```ts
logger.info({
  userId,
  operation: 'createUser',
  userType: 'admin',
  source: 'api'
}, 'User created successfully');
```

### 7.4 Use Operation Tracking

Use operation tracking for important operations:

```ts
await trackOperation('processPayment', async () => {
  // Payment processing code
}, { userId, amount, currency });
```

### 7.5 Handle Sensitive Information

Be careful with sensitive information in logs:

```ts
// Use sanitizeForLogging to redact sensitive fields
const sanitizedData = sanitizeForLogging(userData);
logger.info({ user: sanitizedData }, 'User data processed');
```

## 8. Migration Guide

If you're migrating from the old logging approach to the new standardized system:

1. Replace direct `console.log` calls with structured logging:
   ```ts
   // Old
   console.log(`Processing user ${userId}`);
   
   // New
   getLogger().info({ userId }, 'Processing user');
   ```

2. Replace custom error logging with standardized error logging:
   ```ts
   // Old
   console.error('Error processing request', error);
   
   // New
   logError(error, 'Error processing request', { requestId });
   ```

3. Add operation tracking for important operations:
   ```ts
   // Old
   async function processMessage(message) {
     console.log(`Processing message ${message.id}`);
     // ... processing code
     console.log(`Finished processing message ${message.id}`);
   }
   
   // New
   async function processMessage(message) {
     return trackOperation('processMessage', async () => {
       // ... processing code
     }, { messageId: message.id });
   }
   ```

4. Initialize logging in your application entry point:
   ```ts
   import { Hono } from 'hono';
   import { initLogging, createErrorMiddleware } from '@dome/common';
   
   const app = new Hono();
   initLogging(app, { extraBindings: { service: 'my-service' } });
   app.use('*', createErrorMiddleware());
   
   // Rest of your application
   ```

## 9. Verification

The repository includes verification scripts to ensure compliance with the logging standards:

- `scripts/verify-logging-errors.js`: Verifies that all services are using the standardized logging approach
- `scripts/verify-log-levels.js`: Checks that log levels are used appropriately

Run these scripts regularly to ensure your codebase maintains consistent logging practices.
