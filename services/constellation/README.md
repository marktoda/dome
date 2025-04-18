# Constellation Embedding Service

Constellation is a dedicated Cloudflare Worker that provides embedding and vector search capabilities for the Dome application. The service handles the asynchronous processing of text embedding jobs and provides a typed RPC interface for other workers to interact with.

## Features

- **Asynchronous Embedding Processing**: Consumes raw text jobs from a Workers Queue, converts them into vector embeddings using Workers AI, and upserts them into a shared Vectorize index.
- **RPC Interface**: Provides a typed service binding for other workers to embed, query, and retrieve stats.
- **Robust Error Handling**: Implements retry logic, dead letter queues, and comprehensive logging.
- **Monitoring and Metrics**: Tracks performance metrics and operational statistics.

## Architecture

Constellation consists of several key components:

1. **Queue Consumer**: Processes batches of embedding jobs from the EMBED_QUEUE.
2. **Preprocessor Service**: Handles text normalization and chunking for optimal embedding.
3. **Embedder Service**: Interfaces with Workers AI to generate embeddings.
4. **Vectorize Service**: Manages interactions with the Vectorize index.
5. **RPC Interface**: Exposes typed methods for other workers.

```
┌───────────────┐         enqueue           ┌───────────────┐
│  API Worker   │──────────────────────────▶│  EMBED_QUEUE  │
│  GitHub Cron  │                           └───────────────┘
│  Notion Cron  │                                 ▲
└───────┬───────┘                                 │ batch
        │ service RPC                             │
        ▼                                         │
┌───────────────────────────────────────────────────────────────┐
│             Constellation Worker (service "embedder")          │
│                                                               │
│   queue(jobs)  ─►  embedBatch()  ─►  Workers AI  ─► Vectorize │
│                               ▲               │              │
│     RPC: query(), stats()  ───┘               └───► logs/metrics
└───────────────────────────────────────────────────────────────┘
```

## Usage

### Service Binding

To use Constellation from another worker, add the service binding to your `wrangler.toml`:

```toml
[[services]]
binding   = "CONSTELLATION"
service   = "constellation"
environment = "production"
```

### Enqueuing Jobs for Async Embedding

```typescript
// Enqueue a job for async embedding
await env.QUEUE.send('EMBED_QUEUE', {
  userId: 'user123',
  noteId: 'note456',
  text: 'This is the text to embed',
  created: Date.now(),
  version: 1
});
```

### Direct Embedding (Rare)

```typescript
// Directly embed a note (synchronous, use sparingly)
await env.CONSTELLATION.embed({
  userId: 'user123',
  noteId: 'note456',
  text: 'This is the text to embed',
  created: Date.now(),
  version: 1
});
```

### Vector Search

```typescript
// Search for similar vectors
const results = await env.CONSTELLATION.query(
  'Search query text',
  { userId: 'user123' }, // Optional filter
  10 // Optional topK
);

// Process results
for (const result of results) {
  console.log(`Note ${result.metadata.noteId} matched with score ${result.score}`);
}
```

### Stats

```typescript
// Get index statistics
const stats = await env.CONSTELLATION.stats();
console.log(`Vector index has ${stats.vectors} vectors with dimension ${stats.dimension}`);
```

## Configuration

### Environment Variables

- `VERSION`: Service version
- `ENVIRONMENT`: Deployment environment (production, staging, etc.)

### Bindings

- `VECTORIZE`: Vectorize index binding
- `AI`: Workers AI binding
- `EMBED_QUEUE`: Queue for embedding jobs
- `EMBED_DEAD`: Dead letter queue for failed jobs

## Development

### Local Development

1. Install dependencies:
   ```
   pnpm install
   ```

2. Run the worker locally:
   ```
   pnpm dev
   ```

3. Run tests:
   ```
   pnpm test
   ```

### Deployment

Deploy to Cloudflare:

```
pnpm deploy
```

## Monitoring

Constellation emits structured logs and metrics for monitoring:

### Key Metrics

- `queue.batch_size`: Size of job batches
- `queue.process_batch`: Time to process a batch
- `queue.process_job`: Time to process a single job
- `embedding.batch_size`: Size of embedding batches
- `embedding.duration_ms`: Time to generate embeddings
- `vectorize.upsert.batch_size`: Size of vector upsert batches
- `vectorize.upsert.duration_ms`: Time to upsert vectors
- `vectorize.query.results`: Number of query results
- `vectorize.query.duration_ms`: Time to query vectors

### Error Metrics

- `queue.job_errors`: Count of job processing errors
- `queue.batch_errors`: Count of batch processing errors
- `embedding.errors`: Count of embedding errors
- `vectorize.upsert.errors`: Count of vector upsert errors
- `vectorize.query.errors`: Count of vector query errors

## Error Handling

Constellation implements several error handling strategies:

1. **Retries**: Failed operations are retried with exponential backoff.
2. **Dead Letter Queue**: Persistently failed jobs are sent to a dead letter queue.
3. **Batch Retries**: Entire batches can be retried if needed.
4. **Structured Error Logging**: Errors are logged with context for debugging.

## Performance Considerations

- **Batch Size**: The queue consumer is configured for batches of 10 jobs.
- **Embedding Limits**: Workers AI has a limit of 20 texts per embedding call.
- **Vectorize Limits**: Vectorize has a recommended batch size of 100 vectors.
- **Text Size**: Text should be ≤ 8 kB for optimal performance.