# Logging Style Guide

This document defines the standards and best practices for logging across all services in our application. Following these guidelines ensures consistent, searchable, and actionable logs that facilitate debugging, monitoring, and analysis.

## Log Levels

We use the following standard log levels, each with a specific purpose:

| Level   | Purpose                                                                          | Examples                                                           |
| ------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `trace` | Extremely detailed information, useful only for pinpointing very specific issues | Function entry/exit, variable values during loops                  |
| `debug` | Detailed information useful for debugging                                        | Configuration values, state transitions, detailed processing steps |
| `info`  | General operational information                                                  | Service startup/shutdown, request handling, successful operations  |
| `warn`  | Potentially harmful situations that don't prevent operation                      | Deprecated API usage, fallback behavior, retries                   |
| `error` | Error conditions that prevent an operation from completing                       | Failed requests, database errors, validation failures              |
| `fatal` | Severe error conditions that prevent the application from functioning            | Database connection failures, critical dependency unavailability   |

### When to Use Each Level

- **trace**: Use sparingly and only in development environments. This level is too verbose for production.
- **debug**: Use for information that is useful for debugging but not needed for normal operation. Often disabled in production.
- **info**: Use for normal operational information. This is the default level in production.
- **warn**: Use when something unexpected happened but the application can continue functioning.
- **error**: Use when an operation failed but the application can continue functioning.
- **fatal**: Use when the application cannot continue functioning due to a critical failure.

## Structured Logging

All logs should be structured as JSON objects with consistent field names. This enables efficient searching, filtering, and analysis.

### Standard Fields

The following fields should be included in all log entries:

| Field       | Description                       | Example                                |
| ----------- | --------------------------------- | -------------------------------------- |
| `timestamp` | ISO 8601 timestamp                | `2025-04-20T22:54:31.123Z`             |
| `level`     | Log level                         | `info`                                 |
| `service`   | Service name                      | `silo`                                 |
| `component` | Component within the service      | `database`                             |
| `message`   | Human-readable message            | `Request processed successfully`       |
| `requestId` | Unique identifier for the request | `f8e7d6c5-b4a3-2c1d-0e9f-8a7b6c5d4e3f` |

### Standard Event Names

Use the `LogEvent` enum from `@dome/logging` for consistent event naming across services:

```typescript
import { LogEvent } from '@dome/logging';

logger.info({ event: LogEvent.REQUEST_START }, 'Processing request');
logger.info({ event: LogEvent.OPERATION_END, duration }, 'Operation completed');
```

Common event names include:

| Event Name           | Description                                     |
| -------------------- | ----------------------------------------------- |
| `REQUEST_START`      | Start of a request processing                   |
| `REQUEST_END`        | End of a request processing                     |
| `REQUEST_ERROR`      | Error during request processing                 |
| `OPERATION_START`    | Start of an internal operation                  |
| `OPERATION_END`      | Successful completion of an operation           |
| `OPERATION_ERROR`    | Error during an operation                       |
| `EXTERNAL_CALL`      | External API or service call                    |
| `DATABASE_QUERY`     | Database operation                              |
| `CACHE_HIT`          | Cache hit event                                 |
| `CACHE_MISS`         | Cache miss event                                |
| `WORKER_START`       | Worker startup                                  |
| `WORKER_SHUTDOWN`    | Worker shutdown                                 |

### Context Types

Use the standardized context interfaces for different operation types:

```typescript
import { RequestContext, OperationContext, ExternalCallContext } from '@dome/logging';

// Request context
const requestCtx: RequestContext = {
  requestId,
  path: '/api/users',
  method: 'POST',
  userAgent,
  ip: clientIp
};

// Operation context
const operationCtx: OperationContext = {
  operation: 'createUser',
  component: 'userService',
  duration: 123.45
};

// External call context
const callCtx: ExternalCallContext = {
  url: 'https://api.example.com/data',
  method: 'GET',
  status: 200,
  duration: 342.1
};
```

### Conventions for Field Names

- Use camelCase for field names
- Use descriptive names that clearly indicate the field's purpose
- Avoid abbreviations unless they are widely understood
- Prefix metric names with the service name (e.g., `silo.requests.count`)
- Use dot notation for hierarchical metrics (e.g., `database.query.duration_ms`)

### Sensitive Information

Never log sensitive information such as:

- Passwords or authentication tokens
- Personal identifiable information (PII)
- Credit card numbers or financial information
- API keys or secrets

Use the `sanitizeForLogging` utility to automatically mask sensitive fields:

```typescript
import { sanitizeForLogging } from '@dome/logging';

const userData = { name: 'John', email: 'john@example.com', password: 'secret123' };
logger.info({ user: sanitizeForLogging(userData) }, 'User created');
// The password field will be masked in the logs
```

## Request ID Propagation

Request IDs are crucial for distributed tracing across services. They allow us to correlate logs from different services that processed the same request.

### Guidelines for Request ID Propagation

1. **Generation**: If a request doesn't have a request ID, generate one using `crypto.randomUUID()`.
2. **Headers**: Pass request IDs between services using the `x-request-id` header.
3. **Logging**: Include the request ID in all log entries related to the request.
4. **Context**: Use the logger middleware to automatically include the request ID in all logs.

### Implementation

The `loggerMiddleware` function automatically handles request ID propagation:

```typescript
import { loggerMiddleware } from '@dome/logging';

// In your Hono app
app.use('*', loggerMiddleware());
```

For extracting the current request ID:

```typescript
import { getRequestId } from '@dome/logging';

const requestId = getRequestId();
```

### External Service Calls

When making calls to external services, use the `trackedFetch` utility to automatically propagate the request ID:

```typescript
import { trackedFetch } from '@dome/logging';

// Request ID will be automatically propagated
const response = await trackedFetch(
  'https://api.example.com/data',
  { method: 'POST', body: JSON.stringify(data) },
  { operation: 'fetchExternalData' }
);
```

Or manually propagate the request ID:

```typescript
import { getRequestId } from '@dome/logging';

async function callExternalService(url, data) {
  const requestId = getRequestId();
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-request-id': requestId,
    },
    body: JSON.stringify(data),
  });
  
  // Log the external call with standardized format
  logExternalCall(
    url,
    'POST',
    response.status,
    performance.now() - startTime,
    { requestId, dataSize: JSON.stringify(data).length }
  );
  
  return response;
}
```

## Operation Tracking

For consistent tracking of operations across the codebase, use the standardized operation tracking utilities:

### Using trackOperation

```typescript
import { trackOperation } from '@dome/logging';

// This will automatically log the start and end of the operation
// with standardized format and error handling
const result = await trackOperation(
  'user-creation',
  async () => {
    // Your operation logic here
    return await createUser(userData);
  },
  { userId: userData.id }
);
```

### Manual Operation Tracking

```typescript
import { 
  logOperationStart, 
  logOperationSuccess, 
  logOperationFailure 
} from '@dome/logging';

function processItem(item) {
  const operationName = 'item-processing';
  const context = { itemId: item.id, type: item.type };
  
  logOperationStart(operationName, context);
  const startTime = performance.now();
  
  try {
    // Process the item
    const result = doProcessing(item);
    
    const duration = performance.now() - startTime;
    logOperationSuccess(operationName, duration, context);
    
    return result;
  } catch (error) {
    logOperationFailure(operationName, error, context);
    throw error;
  }
}
```

## Error Logging

Use standardized error logging for all error conditions:

```typescript
import { logError } from '@dome/logging';

try {
  // Operation that might fail
} catch (error) {
  // This extracts and logs all relevant error information
  logError(error, 'Failed to process data', { dataId, operation: 'data-processing' });
  
  // Rethrow if needed
  throw error;
}
```

The `logError` function automatically extracts:
- Error message
- Error name
- Error stack trace
- Error code (if available)
- Status code (if available)
- Error details (if available)
- Cause chain (if available)

## Metrics Collection

Use standardized metrics collection for tracking performance and operational metrics:

```typescript
import { createServiceMetrics } from '@dome/logging';

const metrics = createServiceMetrics('silo');

// Increment a counter
metrics.counter('requests.count');

// Record a value
metrics.gauge('memory.usage', process.memoryUsage().heapUsed);

// Time an operation
const timer = metrics.startTimer('database.query');
try {
  await db.query('SELECT * FROM users');
} finally {
  timer.stop();
}

// Track success/failure
try {
  await processItem(item);
  metrics.trackOperation('item.process', true);
} catch (error) {
  metrics.trackOperation('item.process', false);
  throw error;
}
```

### Standard Metrics Names

Follow these conventions for metric names:

1. Use the format `<service>.<category>.<metric>` (e.g., `silo.requests.count`)
2. For durations, suffix with `_ms` (e.g., `silo.query.duration_ms`)
3. For sizes, suffix with the unit (e.g., `silo.upload.size_bytes`)
4. For rates, suffix with `_per_second` or `_per_minute` (e.g., `silo.requests_per_second`)

## Best Practices

1. **Be Consistent**: Follow these guidelines consistently across all services.
2. **Be Concise**: Log messages should be clear and concise.
3. **Be Contextual**: Include enough context to understand what happened.
4. **Be Actionable**: Logs should help diagnose and fix issues.
5. **Be Mindful of Volume**: Don't log too much or too little.
6. **Use Structured Logging**: Always use structured logging for machine-readability.
7. **Propagate Request IDs**: Always propagate request IDs for distributed tracing.
8. **Monitor and Alert**: Use logs and metrics for monitoring and alerting.
9. **Review and Refine**: Regularly review and refine logging practices.
10. **Document Changes**: Document any changes to logging standards.

## Implementation Examples

### Basic Request Logging

```typescript
import { withLogger } from '@dome/logging';

export async function handleRequest(request) {
  return withLogger(
    {
      service: 'api-gateway',
      component: 'requestHandler',
      path: new URL(request.url).pathname,
      method: request.method,
      requestId: request.headers.get('x-request-id') || crypto.randomUUID()
    },
    async (logger) => {
      logger.info({ event: 'request_start' }, `Start ${request.method} ${new URL(request.url).pathname}`);
      
      const startTime = performance.now();
      try {
        const response = await processRequest(request);
        
        const duration = performance.now() - startTime;
        logger.info(
          { event: 'request_end', duration, status: response.status },
          `Completed ${request.method} ${new URL(request.url).pathname}`
        );
        
        return response;
      } catch (error) {
        const duration = performance.now() - startTime;
        logger.error(
          { event: 'request_error', error, duration },
          `Error processing ${request.method} ${new URL(request.url).pathname}`
        );
        throw error;
      }
    }
  );
}
```

### Database Operation Logging

```typescript
import { getLogger, logError } from '@dome/logging';

async function queryDatabase(sql, params) {
  const logger = getLogger();
  const startTime = performance.now();
  
  logger.debug(
    { event: 'database_query_start', sql, params: sanitizeForLogging(params) },
    'Starting database query'
  );
  
  try {
    const result = await db.query(sql, params);
    
    const duration = performance.now() - startTime;
    logger.debug(
      { 
        event: 'database_query_end', 
        duration, 
        rowCount: result.rowCount 
      },
      'Database query completed'
    );
    
    return result;
  } catch (error) {
    const duration = performance.now() - startTime;
    logError(
      error,
      'Database query failed',
      { sql, params: sanitizeForLogging(params), duration }
    );
    throw error;
  }
}
