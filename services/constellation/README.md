# Constellation Embedding Service

Constellation is a dedicated Cloudflare Worker that provides embedding and vector search capabilities for the Dome application. The service handles the asynchronous processing of text embedding jobs and provides a typed RPC interface for other workers to interact with.

## Features

- **Asynchronous Embedding Processing**: Consumes raw text jobs from a Workers Queue, converts them into vector embeddings using Workers AI, and upserts them into a shared Vectorize index.
- **RPC Interface**: Provides a typed service binding for other workers to embed, query, and retrieve stats.
- **Robust Error Handling**: Implements retry logic, dead letter queues, and comprehensive logging.
- **Monitoring and Metrics**: Tracks performance metrics and operational statistics.
- **Environment-Specific Configuration**: Separate configurations for development, staging, and production environments.

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

## Setup and Installation

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later)
- [pnpm](https://pnpm.io/) package manager
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (v4 or later)
- Cloudflare account with Workers, Vectorize, and Workers AI access

### Initial Setup

1. **Clone the repository and install dependencies**:

   ```bash
   git clone https://github.com/example/dome-cf.git
   cd dome-cf
   pnpm install
   ```

2. **Create Vectorize indexes**:

   ```bash
   # Development index
   wrangler vectorize create dome-notes --dimensions=384
   wrangler vectorize create-metadata-index dome-notes --property-name userId --type string
   wrangler vectorize create-metadata-index dome-notes --property-name noteId --type string
   wrangler vectorize create-metadata-index dome-notes --property-name version --type number

   # For staging/production, see MIGRATION.md
   ```

3. **Create queues**:
   ```bash
   wrangler queues create EMBED_QUEUE
   wrangler queues create embed-dead-letter
   ```

### Environment Configuration

Create a `.dev.vars` file in the `services/constellation` directory:

```
VERSION=1.0.0
ENVIRONMENT=development
LOG_LEVEL=debug
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
  version: 1,
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
  version: 1,
});
```

### Vector Search

```typescript
// Search for similar vectors
const results = await env.CONSTELLATION.query(
  'Search query text',
  { userId: 'user123' }, // Optional filter
  10, // Optional topK
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
- `LOG_LEVEL`: Logging level (debug, info, warn, error)

### Bindings

- `VECTORIZE`: Vectorize index binding
- `AI`: Workers AI binding
- `EMBED_QUEUE`: Queue for embedding jobs
- `EMBED_DEAD`: Dead letter queue for failed jobs

### Environment-Specific Configuration

The `wrangler.toml` file contains environment-specific configurations for:

- **Development**: Local development with minimal concurrency
- **Staging**: Testing environment with moderate concurrency
- **Production**: Production environment with higher concurrency and batch sizes

## Development

### Local Development

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Run the worker locally:

   ```bash
   pnpm dev
   ```

3. Run tests:

   ```bash
   pnpm test
   ```

4. Lint code:
   ```bash
   pnpm lint
   ```

### Testing with Real Data

To test the service with real data locally:

1. Start the local development server:

   ```bash
   pnpm dev
   ```

2. Publish a test message to the queue:

   ```bash
   wrangler queues publish EMBED_QUEUE '{"userId":"test123","noteId":"note123","text":"This is a test note for embedding","created":1650000000000,"version":1}'
   ```

3. Check the logs to verify processing.

### Deployment

Deploy to different environments:

```bash
# Deploy to staging
pnpm deploy:staging

# Deploy to production
pnpm deploy:prod
```

Or use Wrangler directly:

```bash
wrangler deploy --env production
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

### Alerts

Alert configurations are defined in `monitoring/alerts.yaml`. These alerts can be integrated with:

- Email notifications
- Slack channels
- PagerDuty

## Error Handling

Constellation implements several error handling strategies:

1. **Retries**: Failed operations are retried with exponential backoff.
2. **Dead Letter Queue**: Persistently failed jobs are sent to a dead letter queue.
3. **Batch Retries**: Entire batches can be retried if needed.
4. **Structured Error Logging**: Errors are logged with context for debugging.

## Performance Considerations

- **Batch Size**: The queue consumer is configured for batches of 10-20 jobs depending on environment.
- **Embedding Limits**: Workers AI has a limit of 20 texts per embedding call.
- **Vectorize Limits**: Vectorize has a recommended batch size of 100 vectors.
- **Text Size**: Text should be ≤ 8 kB for optimal performance.
- **Concurrency**: Production is configured with higher concurrency (10) than staging (5) or development (1).

## Migration

For detailed instructions on migrating from the previous embedding approach to Constellation, see [MIGRATION.md](./MIGRATION.md).

## Troubleshooting

### Common Issues

1. **High Queue Depth**:

   - Check Workers AI rate limits
   - Increase max_concurrency in wrangler.toml
   - Verify Vectorize index is functioning properly

2. **Embedding Errors**:

   - Check Workers AI service status
   - Verify text preprocessing is working correctly
   - Check for malformed input data

3. **Query Performance Issues**:
   - Use metadata filters to narrow search scope
   - Verify index size and dimension
   - Check for slow network conditions

### Debugging

1. **View logs in real-time**:

   ```bash
   wrangler tail constellation --env production
   ```

2. **Check dead letter queue**:

   ```bash
   wrangler queues list-messages embed-dead-letter-prod
   ```

3. **Test RPC methods directly**:
   ```bash
   curl "https://constellation.example.com/stats"
   ```
