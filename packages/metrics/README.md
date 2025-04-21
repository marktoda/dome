# @dome/metrics

A standardized metrics library for Dome services.

## Installation

```bash
pnpm add @dome/metrics
```

## Usage

### Basic Usage

```typescript
import { createMetrics } from '@dome/metrics';

// Create a metrics service for your service
const metrics = createMetrics('my-service');

// Initialize with environment variables
metrics.init({
  VERSION: '1.0.0',
  ENVIRONMENT: 'production',
});

// Record metrics
metrics.counter('requests', 1);
metrics.gauge('active_connections', 42);
metrics.timing('response_time_ms', 123);
```

### Timing Operations

```typescript
import { createMetrics } from '@dome/metrics';

const metrics = createMetrics('my-service');

async function performOperation() {
  // Start a timer
  const timer = metrics.startTimer('operation');

  try {
    // Perform the operation
    await someAsyncOperation();

    // Stop the timer with success tag
    timer.stop({ success: 'true' });
  } catch (error) {
    // Stop the timer with error tag
    timer.stop({ success: 'false', error: error.name });
    throw error;
  }
}
```

### Tracking API Requests

```typescript
import { createMetrics } from '@dome/metrics';

const metrics = createMetrics('my-service');

async function handleRequest(request) {
  const startTime = performance.now();
  let statusCode = 200;

  try {
    // Process the request
    const response = await processRequest(request);
    return response;
  } catch (error) {
    statusCode = error.statusCode || 500;
    throw error;
  } finally {
    const duration = performance.now() - startTime;
    metrics.trackApiRequest(request.path, request.method, statusCode, duration, {
      user_type: request.userType,
    });
  }
}
```

### Tracking Operation Success/Failure

```typescript
import { createMetrics } from '@dome/metrics';

const metrics = createMetrics('my-service');

async function processItem(item) {
  try {
    await processItemLogic(item);
    metrics.trackOperation('item_processing', true, { type: item.type });
    return true;
  } catch (error) {
    metrics.trackOperation('item_processing', false, {
      type: item.type,
      error: error.name,
    });
    return false;
  }
}
```

### Health Checks

```typescript
import { createMetrics } from '@dome/metrics';

const metrics = createMetrics('my-service');

async function checkHealth() {
  const startTime = performance.now();

  try {
    // Check database connection
    const dbStatus = await checkDatabase();
    const duration = performance.now() - startTime;

    metrics.trackHealthCheck(dbStatus.ok ? 'ok' : 'error', duration, 'database', {
      region: 'us-east-1',
    });

    return dbStatus;
  } catch (error) {
    const duration = performance.now() - startTime;
    metrics.trackHealthCheck('error', duration, 'database', {
      error: error.name,
      region: 'us-east-1',
    });
    throw error;
  }
}
```

## API Reference

### `createMetrics(serviceName, defaultTags?)`

Creates a new metrics service instance.

- `serviceName`: Name of the service (used as metric prefix)
- `defaultTags`: Default tags to include with all metrics (optional)

### Methods

- `init(env)`: Initialize metrics with environment variables
- `counter(name, value?, tags?)`: Increment a counter metric
- `gauge(name, value, tags?)`: Set a gauge metric
- `timing(name, value, tags?)`: Record a timing metric
- `startTimer(name, tags?)`: Create a timer for measuring operation duration
- `trackOperation(name, success, tags?)`: Track the success or failure of an operation
- `trackApiRequest(path, method, statusCode, duration, tags?)`: Track API request metrics
- `trackHealthCheck(status, duration, component?, tags?)`: Track health check metrics
- `getCounter(name)`: Get the current value of a counter
