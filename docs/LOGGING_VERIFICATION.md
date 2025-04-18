# @dome/logging - Verification and Documentation Report

## 1. Summary of Changes Across the Monorepo

### 1.1 The New @dome/logging Package

The `@dome/logging` package has been successfully implemented as a structured, request-aware logging solution for all Dome Workers. This package provides a consistent logging interface across different types of Cloudflare Workers (HTTP, Cron, Queue) with minimal setup.

#### Package Structure

- **Package Name**: `@dome/logging`
- **Version**: `0.1.0`
- **Dependencies**:
  - `hono`: ^4.0.0 (for context storage and middleware)
  - `pino`: ^8.0.0 (for structured logging)
  - `nanoid`: ^3.3.4 (for generating request IDs)
  - `@cloudflare/workers-types`: ^4.0.0 (for TypeScript types)

#### Core Components

1. **Base Logger** (`src/base.ts`):

   - Creates a global Pino logger instance
   - Configures log level from environment or defaults to 'info'
   - Sets up browser-compatible logging for Cloudflare Workers

2. **Helper Functions** (`src/helper.ts`):

   - `getLogger()`: Returns the request-scoped logger if inside ALS context, otherwise returns the base logger

3. **Middleware** (`src/middleware.ts`):

   - `initLogging()`: Convenience function to wire both contextStorage & logging in one call
   - `buildLoggingMiddleware()`: Creates a middleware that attaches a child logger to each request context

4. **Run With Logger** (`src/runWithLogger.ts`):

   - `runWithLogger()`: Function for non-HTTP workers (Cron, Queue) to run code with a logger in context

5. **Types** (`src/types.ts`):
   - `InitOptions`: Interface for logger initialization options

### 1.2 Service Integration

The `@dome/logging` package has been integrated into all three services:

#### 1. dome-api (HTTP API Worker)

- **Integration Method**: Using `initLogging(app)` middleware
- **Configuration**: Added `nodejs_als` compatibility flag in wrangler.toml
- **Usage**:
  - Initialized in main app setup
  - Used in error handlers and route handlers via `getLogger()`
- **Key Files Modified**:
  - `services/dome-api/src/index.ts`: Added import and initialization
  - `services/dome-api/wrangler.toml`: Added compatibility flag

#### 2. dome-cron (Scheduled Worker)

- **Integration Method**: Using `runWithLogger()` function
- **Configuration**: Added `nodejs_als` compatibility flag in wrangler.toml
- **Dependencies**: Added `@dome/logging` as a workspace dependency
- **Usage**: Wraps the scheduled job execution with logging context
- **Key Files Modified**:
  - `services/dome-cron/src/index.ts`: Added import and implementation
  - `services/dome-cron/wrangler.toml`: Added compatibility flag
  - `services/dome-cron/package.json`: Added dependency

#### 3. dome-notify (Queue Worker)

- **Integration Method**: Using `runWithLogger()` function
- **Configuration**: Added `nodejs_als` compatibility flag in wrangler.toml
- **Dependencies**: Added `@dome/logging` as a workspace dependency
- **Usage**: Wraps the queue message processing with logging context
- **Key Files Modified**:
  - `services/dome-notify/src/index.ts`: Added import and implementation
  - `services/dome-notify/wrangler.toml`: Added compatibility flag
  - `services/dome-notify/package.json`: Added dependency

### 1.3 Configuration Changes

All services have been updated with the required configuration:

1. **Wrangler.toml Updates**:

   - All services now include `compatibility_flags = ["nodejs_als"]`
   - All services have a recent `compatibility_date`

2. **Package.json Dependencies**:
   - `dome-cron` and `dome-notify` explicitly list `@dome/logging` as a workspace dependency
   - `dome-api` imports and uses the package but may need to update its package.json to explicitly list the dependency

## 2. Verification Steps

### 2.1 Testing the Logging Functionality

A verification script has been created at `scripts/verify-logging.js` to test the logging implementation. This script:

- Makes requests to a test endpoint to generate logs
- Tracks request IDs for verification
- Provides SQL queries to check logs in Cloudflare Logs Engine

#### Running the Verification Script

```bash
# Basic verification with default settings
node scripts/verify-logging.js

# Custom verification with options
node scripts/verify-logging.js --endpoint https://api.example.com --requests 20 --interval 1000 --error
```

#### Verification Options

- `--endpoint <url>`: Test endpoint URL (default: http://localhost:8787)
- `--requests <num>`: Number of requests to make (default: 10)
- `--interval <ms>`: Interval between requests in ms (default: 500)
- `--error`: Include error requests to test error logging
- `--help`: Show help message

### 2.2 What to Look for in the Logs

When verifying the logging implementation, check for the following:

#### For HTTP API Workers (dome-api)

1. **Request Context Information**:

   - Each log entry should include a `reqId` field
   - IP address (`ip`) should be captured
   - Cloudflare data (`colo`, `cfRay`) should be present

2. **Log Levels**:

   - `info` level for normal operations
   - `error` level for exceptions
   - `debug` level for detailed debugging (if enabled)

3. **Structured Data**:
   - Log entries should include relevant contextual data as JSON
   - Error logs should include error details

#### For Cron Workers (dome-cron)

1. **Execution Context**:

   - Logs should include `trigger: 'cron'`
   - Cron schedule information should be present
   - Environment information should be included

2. **Batch Processing**:
   - Logs for batch processing should include counts
   - Start and completion logs should be present

#### For Queue Workers (dome-notify)

1. **Message Processing**:

   - Logs should include `trigger: 'queue'`
   - Batch size information should be present
   - Message IDs should be logged

2. **Error Handling**:
   - Failed message processing should be logged with error details
   - Successful processing should be logged

### 2.3 Checking Logs in Cloudflare Logs Engine

To verify logs in Cloudflare Logs Engine:

1. Log in to the Cloudflare Dashboard (https://dash.cloudflare.com)
2. Navigate to Workers & Pages → Logs
3. Select the "dome_logs" dataset
4. Run one of these queries to view the logs:

```sql
-- Query for all logs from a verification run
SELECT
  ts,
  lvl,
  service,
  msg,
  requestId,
  data
FROM dome_logs
WHERE requestId IN ('request-id-1', 'request-id-2', ...)
ORDER BY ts ASC

-- Query for error logs
SELECT
  ts,
  service,
  msg,
  err.name,
  err.msg,
  requestId
FROM dome_logs
WHERE lvl = 'error'
  AND ts > now() - INTERVAL 1 HOUR
ORDER BY ts DESC
LIMIT 100

-- Query for request durations
SELECT
  requestId,
  service,
  durMs,
  data.path as path
FROM dome_logs
WHERE msg = 'request:end'
  AND ts > now() - INTERVAL 1 HOUR
ORDER BY durMs DESC
LIMIT 20
```

### 2.4 Potential Issues to Watch For

1. **Missing ALS Configuration**:

   - If logs don't include request context, check that `nodejs_als` is enabled in wrangler.toml
   - Verify the compatibility date is recent enough

2. **Logger Not Initialized**:

   - If logs are missing, ensure `initLogging(app)` is called before other middleware in HTTP workers
   - For Cron/Queue workers, ensure `runWithLogger()` wraps the execution

3. **Incorrect Log Levels**:

   - If logs are too verbose or too sparse, check the log level configuration
   - Default level is 'info', but can be customized

4. **Performance Impact**:
   - Monitor request durations to ensure logging doesn't significantly impact performance
   - Avoid excessive logging in hot paths

## 3. Migration Guide for Future Services

### 3.1 Step-by-Step Integration Instructions

#### For HTTP API Workers

1. **Add the dependency**:

   ```bash
   pnpm add @dome/logging --filter your-service
   ```

2. **Update wrangler.toml**:

   ```toml
   compatibility_date = "2025-04-17"  # or newer
   compatibility_flags = ["nodejs_als"]
   ```

3. **Initialize in your application**:

   ```typescript
   import { Hono } from 'hono';
   import { initLogging, getLogger } from '@dome/logging';

   const app = new Hono();

   // Initialize logging early in the middleware chain
   initLogging(app);

   // Add other middleware and routes
   app.use('*', otherMiddleware());

   app.get('/example', c => {
     getLogger().info({ path: c.req.path }, 'Handling request');
     return c.json({ success: true });
   });

   // Add error handling
   app.onError((err, c) => {
     getLogger().error({ err, path: c.req.path }, 'Unhandled error');
     return c.json({ error: 'Internal server error' }, 500);
   });

   export default app;
   ```

#### For Cron Workers

1. **Add the dependency**:

   ```bash
   pnpm add @dome/logging --filter your-cron-service
   ```

2. **Update wrangler.toml**:

   ```toml
   compatibility_date = "2025-04-17"  # or newer
   compatibility_flags = ["nodejs_als"]
   ```

3. **Implement in your scheduled handler**:

   ```typescript
   import { runWithLogger, getLogger } from '@dome/logging';

   export default {
     async scheduled(event, env, ctx) {
       await runWithLogger(
         {
           trigger: 'cron',
           cron: event.cron,
           environment: env.ENVIRONMENT,
         },
         async () => {
           getLogger().info('Starting scheduled job');

           try {
             // Your job logic here
             getLogger().info('Job completed successfully');
           } catch (error) {
             getLogger().error({ error }, 'Job failed');
             throw error;
           }
         },
         ctx,
       );
     },
   };
   ```

#### For Queue Workers

1. **Add the dependency**:

   ```bash
   pnpm add @dome/logging --filter your-queue-service
   ```

2. **Update wrangler.toml**:

   ```toml
   compatibility_date = "2025-04-17"  # or newer
   compatibility_flags = ["nodejs_als"]
   ```

3. **Implement in your queue handler**:

   ```typescript
   import { runWithLogger, getLogger } from '@dome/logging';

   export default {
     async queue(batch, env, ctx) {
       await runWithLogger(
         {
           trigger: 'queue',
           batchSize: batch.messages.length,
           environment: env.ENVIRONMENT,
         },
         async () => {
           getLogger().info({ batchSize: batch.messages.length }, 'Processing message batch');

           for (const message of batch.messages) {
             try {
               getLogger().info({ messageId: message.id }, 'Processing message');

               // Process the message

               batch.ack(message.id);
               getLogger().info({ messageId: message.id }, 'Successfully processed message');
             } catch (error) {
               getLogger().error({ messageId: message.id, error }, 'Error processing message');
               batch.ack(message.id); // or retry logic
             }
           }
         },
         ctx,
       );
     },
   };
   ```

### 3.2 Best Practices for Using the Logging Package

1. **Structured Logging**:

   - Always include relevant context as an object in the first parameter
   - Use the message string (second parameter) for human-readable descriptions

   ```typescript
   // Good
   getLogger().info({ userId, action }, 'User logged in');

   // Avoid
   getLogger().info(`User ${userId} logged in`);
   ```

2. **Log Levels**:

   - Use appropriate log levels for different types of information:
     - `error`: For errors and exceptions
     - `warn`: For warning conditions
     - `info`: For general informational messages (default)
     - `debug`: For detailed debugging information
     - `trace`: For very detailed tracing information

3. **Error Logging**:

   - Always include the full error object when logging errors

   ```typescript
   try {
     // code that might throw
   } catch (error) {
     getLogger().error({ error }, 'Operation failed');
   }
   ```

4. **Request Lifecycle Logging**:

   - Log at key points in the request lifecycle:
     - Start of request processing
     - Important decision points
     - End of request processing
     - Error conditions

5. **Performance Considerations**:

   - Avoid excessive logging in hot paths
   - Use conditional logging for verbose information

   ```typescript
   if (getLogger().isLevelEnabled('debug')) {
     // Expensive operation to gather debug data
     getLogger().debug({ detailedData }, 'Detailed debug info');
   }
   ```

6. **Sensitive Information**:

   - Never log sensitive information (passwords, tokens, PII)
   - Consider implementing a redaction mechanism for sensitive fields

7. **Custom Request IDs**:

   - You can provide a custom ID factory when initializing logging:

   ```typescript
   initLogging(app, {
     idFactory: () => `req-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
   });
   ```

8. **Extra Bindings**:
   - Add service-wide context using extraBindings:
   ```typescript
   initLogging(app, {
     extraBindings: {
       service: 'my-service',
       version: '1.0.0',
       environment: env.ENVIRONMENT,
     },
   });
   ```

### 3.3 Troubleshooting Common Issues

1. **Logger Not Available in Context**:

   - Ensure `initLogging(app)` is called before accessing the logger
   - For non-HTTP workers, ensure code is wrapped with `runWithLogger()`
   - Check that `nodejs_als` is enabled in wrangler.toml

2. **Missing Request Context**:

   - Verify the middleware is registered correctly
   - Ensure the middleware runs before your route handlers

3. **Logs Not Appearing**:

   - Check the log level configuration
   - Verify Cloudflare Logs Engine is properly configured
   - For local development, check console output

4. **Performance Issues**:
   - Reduce log verbosity in production
   - Use conditional logging for expensive operations
   - Consider sampling for high-volume endpoints

## 4. Conclusion

The `@dome/logging` package provides a robust, consistent logging solution across all Dome Workers. By following this guide, you can ensure that all services use the same logging patterns, making it easier to monitor, debug, and maintain the platform.

The implementation follows best practices for structured logging and takes advantage of Cloudflare Workers' features like ALS (Async Local Storage) to maintain request context throughout the request lifecycle.

For any issues or questions about the logging implementation, refer to the package documentation or contact the platform team.
