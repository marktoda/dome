# Constellation Service

The Constellation service is responsible for vector embeddings and semantic search in the Dome platform. It provides a simple API for embedding content, querying vectors, and retrieving statistics.

## ConstellationClient

The `ConstellationClient` is a type-safe client for interacting with the Constellation service. It provides methods for all Constellation operations and handles error logging, metrics, and validation.

### Installation

To use the ConstellationClient in another service, you need to add the Constellation service as a dependency in your `package.json` file:

```json
{
  "dependencies": {
    "constellation": "workspace:*"
  }
}
```

### Usage

Here's how to use the ConstellationClient in another service:

```typescript
import { createConstellationClient, ConstellationClient } from 'constellation/client';

// Create a ConstellationClient instance
const constellationClient: ConstellationClient = createConstellationClient(
  env.CONSTELLATION,
  'your-service.constellation',
);

// Embed content
await constellationClient.embed({
  userId: 'user123',
  contentId: 'content123',
  text: 'Hello, world!',
  created: Date.now(),
  version: 1,
  category: 'note',
  mimeType: 'text/markdown',
});

// Query vectors
const results = await constellationClient.query('Hello, world!', { userId: 'user123' }, 10);

// Get statistics
const stats = await constellationClient.stats();
```

### API Reference

#### `createConstellationClient(binding: ConstellationBinding, metricsPrefix?: string): ConstellationClient`

Creates a new ConstellationClient instance.

- `binding`: The Cloudflare Worker binding to the Constellation service
- `metricsPrefix`: Optional prefix for metrics (defaults to 'constellation.client')

#### `ConstellationClient` Interface

```typescript
interface ConstellationClient {
  embed(job: SiloEmbedJob): Promise<void>;
  query(text: string, filter?: Partial<VectorMeta>, topK?: number): Promise<VectorSearchResult[]>;
  stats(): Promise<VectorIndexStats>;
}
```

### Migration Guide

If you're currently using a custom ConstellationService implementation in your service, here's how to migrate to the ConstellationClient:

#### Before:

```typescript
// In your service
export class ConstellationService {
  constructor(private readonly env: Bindings) {}

  async query(
    text: string,
    filter?: Partial<VectorMeta>,
    topK?: number,
  ): Promise<VectorSearchResult[]> {
    // Custom implementation
  }
}

// Usage
const constellationService = new ConstellationService(env);
const results = await constellationService.query('Hello, world!', { userId: 'user123' }, 10);
```

#### After:

```typescript
// Import the ConstellationClient
import { createConstellationClient, ConstellationClient } from 'constellation/client';

// Create a ConstellationClient instance
const constellationClient: ConstellationClient = createConstellationClient(
  env.CONSTELLATION,
  'your-service.constellation',
);

// Usage
const results = await constellationClient.query('Hello, world!', { userId: 'user123' }, 10);
```

## Benefits of Using ConstellationClient

- **Type Safety**: The ConstellationClient provides type-safe methods for all Constellation operations.
- **Consistent Error Handling**: All methods handle errors consistently and log them with appropriate context.
- **Metrics**: All methods track metrics for success, errors, and latency.
- **Simplified API**: The ConstellationClient provides a simplified API for common operations.
- **Reduced Code Duplication**: No need to implement the same logic in multiple services.
- **Maintainability**: Changes to the Constellation API only need to be made in one place.
