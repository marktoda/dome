# @dome2/shared

Shared utilities, types, and configurations for the Dome2 RAG platform.

## Installation

This package is part of the Dome2 monorepo and is automatically available to
other packages in the workspace.

```bash
pnpm add @dome2/shared
```

## Usage

### Configuration

```typescript
import { config, kafkaConfig, vectorStoreConfig } from '@dome2/shared/config';

// Access environment variables
console.log(config.NODE_ENV);
console.log(kafkaConfig.brokers);
```

### Logger

```typescript
import { logger, createLogger, logError } from '@dome2/shared/logger';

// Create a module-specific logger
const log = createLogger('my-module');

// Log messages
log.info('Starting process');
log.error('An error occurred', { details: 'error details' });

// Log errors with context
try {
  // some operation
} catch (error) {
  logError(error as Error, { module: 'my-module' });
}
```

### Types

```typescript
import {
  Document,
  QueryRequest,
  Connector,
  VectorStore,
  Dome2Error,
} from '@dome2/shared/types';

// Use shared interfaces and types
const doc: Document = {
  id: '123',
  text: 'Sample document',
  metadata: {
    source: 'github',
    sourceId: 'repo/file.ts',
    orgId: 'org-123',
    visibility: 'public',
    createdAt: new Date(),
    updatedAt: new Date(),
  },
};
```

### Utilities

```typescript
import {
  generateId,
  retry,
  chunkArray,
  PerformanceTimer,
} from '@dome2/shared/utils';

// Generate unique IDs
const id = generateId('doc');

// Retry operations
const result = await retry(async () => fetchData(), {
  maxAttempts: 3,
  backoff: 'exponential',
});

// Measure performance
const timer = new PerformanceTimer();
// ... do work
timer.mark('step1');
// ... more work
console.log(`Duration: ${timer.getDuration()}ms`);
```

## Modules

- **config**: Environment variable management with Zod validation
- **logger**: Winston-based logging with structured output
- **types**: Shared TypeScript interfaces and types
- **utils**: Common utility functions

## Development

```bash
# Build the package
pnpm build

# Run in watch mode
pnpm dev

# Type check
pnpm typecheck


```
