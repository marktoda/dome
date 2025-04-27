# @dome/logging

A comprehensive, context-aware logging package for Cloudflare Workers that:

1. Provides structured, contextual logging across async operations
2. Makes the logger available everywhere (fetch / scheduled / queue / tests)
3. Keeps output Cloudflare-Logs-friendly with optimized JSON formatting
4. Includes built-in metrics collection and operation tracking
5. Offers powerful utilities for standardized error logging

## Key Features

- Uses Node.js AsyncLocalStorage for reliable context propagation
- Silent fallback to base logger when outside ALS context
- Cloudflare-Logs-friendly JSON output
- Error stack traces bubbled to top level for better visibility in Cloudflare Logs
- Compatible with Hono middleware for request-scoped logging
- Standardized metrics collection
- Common logging pattern helpers for consistent logging

## Requirements

This package requires the `nodejs_als` compatibility flag in your wrangler.toml:

```toml
compatibility_flags = ["nodejs_als"]   # or nodejs_compat
```

## Usage

### Basic Usage

```typescript
import { withLogger, getLogger } from '@dome/logging';

export default {
  async fetch(request, env, ctx) {
    return withLogger(
      {
        service: 'dome-api',
        component: 'fetch_handler',
        environment: env.ENVIRONMENT,
        version: env.VERSION,
      },
      async log => {
        log.info({ path: new URL(request.url).pathname }, 'Request received');

        // Your handler code here

        return new Response('Hello World');
      },
    );
  },

  async queue(batch, env, ctx) {
    return withLogger(
      {
        service: 'dome-api',
        component: 'queue_consumer',
        batchSize: batch.messages.length,
        environment: env.ENVIRONMENT,
        version: env.VERSION,
      },
      async log => {
        log.info('Processing batch');
        // Process queue messages
      },
    );
  },

  async scheduled(event, env, ctx) {
    return withLogger(
      {
        service: 'dome-cron',
        component: 'scheduled_job',
        cron: event.cron,
        environment: env.ENVIRONMENT,
        version: env.VERSION,
      },
      async log => {
        log.info('Running scheduled job');
        // Run scheduled job
      },
    );
  },
};
```

### Using getLogger in Downstream Functions

```typescript
import { getLogger } from '@dome/logging';

export async function processData(data) {
  const log = getLogger();
  log.debug({ dataSize: data.length }, 'Processing data');

  // Process data

  log.info('Data processing complete');
}
```

### Hono Middleware

```typescript
import { Hono } from 'hono';
import { initLogging, getLogger } from '@dome/logging';

const app = new Hono();

// Initialize logging middleware
initLogging(app, {
  extraBindings: {
    service: 'dome-api',
    version: '1.0.0',
  },
});

app.get('/', c => {
  const log = getLogger();
  log.info('Handling request');
  return c.json({ message: 'Hello World' });
});

export default app;
```

### Enhanced Error Logging

```typescript
import { getLogger, logError } from '@dome/logging';

try {
  // Some code that might throw
} catch (error) {
  logError(error, 'Operation failed', { operationId: 'create-user' });
  // Error stack traces and detailed information are automatically included
}
```

### Tracking Operations with Standard Patterns

```typescript
import { trackOperation, logOperationStart, logOperationSuccess, logOperationFailure } from '@dome/logging';

// Option 1: All-in-one tracking helper
const result = await trackOperation(
  'user-creation',
  async () => {
    // Your operation logic here
    return await createUser(userData);
  },
  { userId: userData.id }
);

// Option 2: Manual tracking
function createResource(data) {
  const logger = getLogger();
  const operationName = 'resource-creation';
  const context = { resourceType: data.type };
  
  logOperationStart(operationName, context);
  const startTime = performance.now();
  
  try {
    const result = /* create the resource */;
    const duration = performance.now() - startTime;
    logOperationSuccess(operationName, duration, { ...context, resourceId: result.id });
    return result;
  } catch (error) {
    logOperationFailure(operationName, error, context);
    throw error;
  }
}
```

### Using Metrics

```typescript
import { createServiceMetrics } from '@dome/logging';

const metrics = createServiceMetrics('silo');

// Increment a counter
metrics.counter('requests.count');

// Record a gauge value
metrics.gauge('memory.usage', process.memoryUsage().heapUsed);

// Time an operation
const timer = metrics.startTimer('database.query');
try {
  await database.query('SELECT * FROM items');
} finally {
  timer.stop(); // Automatically logs the duration
}

// Track operation success/failure
try {
  await processItem(item);
  metrics.trackOperation('item.process', true);
} catch (error) {
  metrics.trackOperation('item.process', false);
  throw error;
}
```

### Making External API Calls with Request ID Propagation

```typescript
import { trackedFetch, getRequestId } from '@dome/logging';

// Automatically propagates request ID and logs the external call
const response = await trackedFetch(
  'https://api.example.com/data',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'example' })
  },
  { operation: 'fetch-external-data' }
);

// Manual request ID propagation
async function callExternalService(url, data) {
  const requestId = getRequestId();
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-request-id': requestId
    },
    body: JSON.stringify(data)
  });
}
```

### Sanitizing Sensitive Data

```typescript
import { sanitizeForLogging } from '@dome/logging';

const userData = {
  name: 'John Doe',
  email: 'john@example.com',
  password: 'secret123',
  apiToken: 'sk_live_1234',
  preferences: {
    theme: 'dark',
    accessToken: 'eyJhbGciOi...'
  }
};

// Sanitize before logging
const safeUserData = sanitizeForLogging(userData);
logger.info({ user: safeUserData }, 'User preferences updated');

// Output will mask sensitive fields:
// { "user": { "name": "John Doe", "email": "john@example.com", "password": "***", "apiToken": "***", "preferences": { "theme": "dark", "accessToken": "***" } } }
```

### Advanced Middleware Configuration

```typescript
import { buildLoggingMiddleware } from '@dome/logging';
import { Hono } from 'hono';

const app = new Hono();

// Create custom middleware with advanced options
app.use('*', buildLoggingMiddleware({
  extraBindings: {
    service: 'dome-api',
    version: '1.0.0',
  },
  includeHeaders: true,
  includeRequestBody: true,
  maxBodySize: 2048,
  sensitiveHeaders: ['authorization', 'cookie', 'x-api-key'],
  shouldLogRequest: (c) => !c.req.path.startsWith('/health'),
  metadataExtractor: (c) => ({
    tenant: c.req.header('x-tenant-id'),
    clientApp: c.req.header('x-client-app')
  })
}));
```

## Log Levels

| Level   | Purpose                                                              |
|---------|----------------------------------------------------------------------|
| `trace` | Extremely detailed information for debugging specific issues          |
| `debug` | Detailed information useful during development and troubleshooting    |
| `info`  | General operational information about system behavior                 |
| `warn`  | Potentially harmful situations that don't prevent normal operation    |
| `error` | Error conditions that prevent an operation from completing correctly  |
| `fatal` | Critical errors that prevent the application from functioning properly|

## Best Practices

1. **Use structured logging**
   ```typescript
   // Good
   logger.info({ userId, action: 'login', device }, 'User logged in');
   
   // Avoid
   logger.info(`User ${userId} logged in from ${device}`);
   ```

2. **Use appropriate log levels**
   ```typescript
   // Debug information
   logger.debug({ config }, 'Application configured');
   
   // Normal operations
   logger.info({ userId }, 'User account created');
   
   // Issues that don't stop operation
   logger.warn({ feature: 'legacy-auth' }, 'Using deprecated authentication method');
   
   // Errors that prevent completion
   logger.error({ error }, 'Failed to process payment');
   ```

3. **Include contextual information**
   ```typescript
   logger.info({
     requestId,
     userId, 
     operation: 'document-upload',
     fileSize: file.size,
     mimeType: file.type
   }, 'Document uploaded successfully');
   ```

4. **Use helper utilities for common patterns**
   ```typescript
   // For tracked operations
   await trackOperation('payment-processing', async () => {
     // process payment
   }, { orderId, amount });
   
   // For error logging
   try {
     // risky operation
   } catch (error) {
     logError(error, 'Payment processing failed', { orderId });
   }
   ```

For more detailed guidelines, refer to the [Logging Standards](../../docs/standards/logging.md) documentation.
