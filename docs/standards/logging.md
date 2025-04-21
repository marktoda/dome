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

### Event-Specific Fields

For specific events, include additional fields that provide context:

| Event Type         | Additional Fields                | Example                                                               |
| ------------------ | -------------------------------- | --------------------------------------------------------------------- |
| Request Start      | `path`, `method`, `userAgent`    | `{ path: "/api/v1/users", method: "GET" }`                            |
| Request End        | `status`, `duration`             | `{ status: 200, duration: 42.5 }`                                     |
| Error              | `error`, `stack`                 | `{ error: "Not Found", stack: "..." }`                                |
| Database Operation | `query`, `duration`              | `{ query: "SELECT * FROM users", duration: 12.3 }`                    |
| External API Call  | `endpoint`, `duration`, `status` | `{ endpoint: "https://api.example.com", duration: 230, status: 200 }` |

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

## Request ID Propagation

Request IDs are crucial for distributed tracing across services. They allow us to correlate logs from different services that processed the same request.

### Guidelines for Request ID Propagation

1. **Generation**: If a request doesn't have a request ID, generate one using `crypto.randomUUID()`.
2. **Headers**: Pass request IDs between services using the `x-request-id` header.
3. **Logging**: Include the request ID in all log entries related to the request.
4. **Context**: Use the logger middleware to automatically include the request ID in all logs.

### Implementation

```typescript
// Example of request ID propagation in middleware
export function loggerMiddleware() {
  return async (c: Context, next: Next) => {
    const requestId = c.req.header('x-request-id') || crypto.randomUUID();

    return withLogger({ requestId, path: c.req.path, method: c.req.method }, async logger => {
      c.set('logger', logger);
      logger.info({ event: 'request_start' });

      const startTime = performance.now();
      try {
        await next();
      } catch (error) {
        logger.error({ event: 'request_error', error });
        throw error;
      } finally {
        logger.info({
          event: 'request_end',
          duration: performance.now() - startTime,
          status: c.res.status,
        });
      }
    });
  };
}
```

### External Service Calls

When making calls to external services, propagate the request ID:

```typescript
// Example of request ID propagation in external service calls
async function callExternalService(url: string, data: any) {
  const logger = getLogger();
  const requestId = als.getStore()?.get('requestId') as string;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-request-id': requestId,
    },
    body: JSON.stringify(data),
  });

  logger.info({
    event: 'external_service_call',
    url,
    status: response.status,
    requestId,
  });

  return response;
}
```

## Metrics Collection

In addition to logging, we collect metrics to monitor the health and performance of our services.

### Standard Metrics

| Metric Type | Purpose                | Example                    |
| ----------- | ---------------------- | -------------------------- |
| Counter     | Count of events        | `silo.requests.count`      |
| Gauge       | Point-in-time value    | `silo.memory.usage`        |
| Timing      | Duration of operations | `silo.request.duration_ms` |

### Implementation

Use the standardized metrics interface:

```typescript
// Example of metrics collection
import { createServiceMetrics } from '@dome/logging';

const metrics = createServiceMetrics('silo');

// Count requests
metrics.counter('requests');

// Measure memory usage
metrics.gauge('memory.usage', process.memoryUsage().heapUsed);

// Time an operation
const timer = metrics.startTimer('database.query');
try {
  await db.query('SELECT * FROM users');
} finally {
  timer.stop();
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
