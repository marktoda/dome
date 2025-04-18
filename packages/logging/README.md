# @dome/logging

A pragmatic logging package for Cloudflare Workers that:

1. Stops the "context-not-available" spam
2. Makes the logger available everywhere (fetch / scheduled / queue / tests)
3. Keeps the output Cloudflare-Logs-friendly

## Key Features

- Uses Node.js AsyncLocalStorage for reliable context propagation
- Silent fallback to base logger when outside ALS context
- Cloudflare-Logs-friendly JSON output
- Error stack traces bubbled to top level for better visibility in Cloudflare Logs
- Compatible with Hono middleware for request-scoped logging

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
        svc: 'dome-api',
        op: 'fetch_handler',
        env: env.ENVIRONMENT,
        ver: env.VERSION,
      },
      async (log) => {
        log.info({ path: new URL(request.url).pathname }, 'Request received');
        
        // Your handler code here
        
        return new Response('Hello World');
      }
    );
  },
  
  async queue(batch, env, ctx) {
    return withLogger(
      {
        svc: 'dome-api',
        op: 'queue_consumer',
        batchSize: batch.messages.length,
        env: env.ENVIRONMENT,
        ver: env.VERSION,
      },
      async (log) => {
        log.info('Processing batch');
        // Process queue messages
      }
    );
  },
  
  async scheduled(event, env, ctx) {
    return withLogger(
      {
        svc: 'dome-cron',
        op: 'scheduled_job',
        cron: event.cron,
        env: env.ENVIRONMENT,
        ver: env.VERSION,
      },
      async (log) => {
        log.info('Running scheduled job');
        // Run scheduled job
      }
    );
  }
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
  }
});

app.get('/', (c) => {
  const log = getLogger();
  log.info('Handling request');
  return c.json({ message: 'Hello World' });
});

export default app;
```

### Logging Errors

```typescript
import { getLogger } from '@dome/logging';

try {
  // Some code that might throw
} catch (error) {
  const log = getLogger();
  log.error(error, 'Operation failed');
  // Error stack traces are automatically bubbled to top level
}
```

## Migration from Previous Version

If you were using the previous version of this package, here are the changes:

1. `runWithLogger` has been replaced with `withLogger` (with a different parameter order)
2. No more "context-not-available" spam in logs
3. Logger is available in all environments (fetch, scheduled, queue, tests)
4. Error stack traces are automatically bubbled to top level

### Parameter Order Change

The parameter order has changed from:
```typescript
// Old
runWithLogger(meta, level, fn, ctx)

// New
withLogger(meta, fn, level)
```

Note that the `ctx` parameter is no longer needed as AsyncLocalStorage handles the context automatically.

## Optional Enhancements

- **Hide metrics from regular logs**: Add a dedicated Pino transport that filters on metric field and ships them to Telemetry/Prometheus instead of Workers Logs.
- **Per-request correlation**: Include requestId (from CF trace-id header) in the meta you pass to withLogger for automatic correlation across micro-services.
- **Pretty output in local development**: Use pino-pretty in development environments with `if (env.ENVIRONMENT === 'development') baseLogger.transport = { target:'pino-pretty' }`.
- **Flush on exit**: For long-running cron/queue jobs, wrap the worker entry point in `pino.final(baseLogger, ...)` so nothing is lost on isolate shutdown.
