# Silo Service

The Silo service is responsible for storing and retrieving content in the Dome platform. It provides a simple API for storing, retrieving, and deleting content.

## SiloClient

The `SiloClient` is a type-safe client for interacting with the Silo service. It provides methods for all Silo operations and handles error logging, metrics, and validation.

### Installation

To use the SiloClient in another service, you need to add the Silo service as a dependency in your `package.json` file:

```json
{
  "dependencies": {
    "@dome/silo": "workspace:*"
  }
}
```

### Usage

Here's how to use the SiloClient in another service:

```typescript
import { createSiloClient, SiloClient } from '@dome/silo/client';

// Create a SiloClient instance
const siloClient: SiloClient = createSiloClient(
  env.SILO,
  env.SILO_INGEST_QUEUE,
  'your-service.silo',
);

// Upload content
const content = await siloClient.uploadSingle({
  content: 'Hello, world!',
  userId: 'user123',
  category: 'note',
  mimeType: 'text/markdown',
});

// Retrieve content
const result = await siloClient.batchGet({
  ids: [content.id],
  userId: 'user123',
});

// Get a single content item
const item = await siloClient.getContent(content.id, 'user123');

// Fetch content as a string
const contentText = await siloClient.fetchContent(content.id, 'user123');

// Delete content
await siloClient.delete({
  id: content.id,
  userId: 'user123',
});

// Get storage statistics
const stats = await siloClient.stats();
```

### API Reference

#### `createSiloClient(binding: SiloBinding, queue: Queue<SiloSimplePutInput>, metricsPrefix?: string): SiloClient`

Creates a new SiloClient instance.

- `binding`: The Cloudflare Worker binding to the Silo service
- `queue`: The Cloudflare Worker queue binding for the ingest queue
- `metricsPrefix`: Optional prefix for metrics (defaults to 'silo.client')

#### `SiloClient` Interface

```typescript
interface SiloClient {
  upload(contents: SiloSimplePutInput[]): Promise<string[]>;
  uploadSingle(content: SiloSimplePutInput): Promise<SiloSimplePutResponse>;
  get(contentId: string, userId?: string): Promise<SiloBatchGetItem>;
  batchGet(params: SiloBatchGetInput): Promise<SiloBatchGetResponse>;
  delete(params: SiloDeleteInput): Promise<SiloDeleteResponse>;
  stats(): Promise<SiloStatsResponse>;
  fetchContent(contentId: string, userId: string | null): Promise<string>;
  getContent(id: string, userId?: string | null): Promise<SiloBatchGetItem>;
  normalizeUserId(userId: string | null): string;
}
```

### Migration Guide

If you're currently using a custom SiloService implementation in your service, here's how to migrate to the SiloClient:

#### Before:

```typescript
// In your service
export class SiloService {
  constructor(private readonly silo: SiloBinding) {}

  async fetchContent(contentId: string, userId: string | null): Promise<string> {
    // Custom implementation
  }
}

// Usage
const siloService = new SiloService(env.SILO);
const content = await siloService.fetchContent('content123', 'user123');
```

#### After:

```typescript
// Import the SiloClient
import { createSiloClient, SiloClient } from '@dome/silo/client';

// Create a SiloClient instance
const siloClient: SiloClient = createSiloClient(
  env.SILO,
  env.SILO_INGEST_QUEUE,
  'your-service.silo',
);

// Usage
const content = await siloClient.fetchContent('content123', 'user123');
```

## Benefits of Using SiloClient

- **Type Safety**: The SiloClient provides type-safe methods for all Silo operations.
- **Consistent Error Handling**: All methods handle errors consistently and log them with appropriate context.
- **Metrics**: All methods track metrics for success, errors, and latency.
- **Simplified API**: The SiloClient provides a simplified API for common operations like fetching content.
- **Reduced Code Duplication**: No need to implement the same logic in multiple services.
- **Maintainability**: Changes to the Silo API only need to be made in one place.

## Configuration

### Environment Variables

| Variable | Description | Required | Default |
| -------- | ----------- | -------- | ------- |
| `LOG_LEVEL` | Logging level | No | `info` |
| `VERSION` | Service version | No | `1.0.0` |
| `ENVIRONMENT` | Deployment environment | No | `prod` |
| `BUCKET` | R2 bucket for stored content | Yes | - |
| `DB` | D1 database for metadata | Yes | - |
| `NEW_CONTENT_CONSTELLATION` | Queue for Constellation embedding jobs | Yes | - |
| `NEW_CONTENT_AI` | Queue for AI processing jobs | Yes | - |
| `INGEST_DLQ` | Dead letter queue for ingest failures | Yes | - |
| `SILO_INGEST_QUEUE` | Queue for ingestion tasks | Yes | - |
