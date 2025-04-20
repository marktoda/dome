# Constellation Embedding Service

Constellation is a dedicated Cloudflare Worker that provides embedding and vector search capabilities for the Dome application. The service handles the asynchronous processing of text embedding jobs and provides a typed RPC interface for other workers to interact with.

## Features

- **Asynchronous Embedding Processing**: Consumes raw text jobs from a Workers Queue, converts them into vector embeddings using Workers AI, and upserts them into a shared Vectorize index.
- **RPC Interface**: Provides a typed service binding for other workers to embed, query, and retrieve stats.
- **Robust Error Handling**: Implements retry logic, dead letter queues, and comprehensive logging.
- **Monitoring and Metrics**: Tracks performance metrics and operational statistics.
- **Environment-Specific Configuration**: Separate configurations for development, staging, and production environments.
- **Text Preprocessing**: Handles text normalization and chunking for optimal embedding quality.
- **Metadata Filtering**: Supports filtering search results by user, note, and version.

## Architecture

Constellation consists of several key components:

1. **Queue Consumer**: Processes batches of embedding jobs from the embed-queue.
2. **Preprocessor Service**: Handles text normalization and chunking for optimal embedding.
3. **Embedder Service**: Interfaces with Workers AI to generate embeddings.
4. **Vectorize Service**: Manages interactions with the Vectorize index.
5. **RPC Interface**: Exposes typed methods for other workers.

```
┌───────────────┐         enqueue           ┌───────────────┐
│  API Worker   │──────────────────────────▶│  embed-queue  │
│  GitHub Cron  │                           └───────────────┘
│  Notion Cron  │                                 ▲
└───────┬───────┘                                 │ batch
        │ service RPC                             │
        ▼                                         │
┌───────────────────────────────────────────────────────────────┐
│             Constellation Worker (service "embedder")          │
│                                                               │
│   ┌─────────────┐    ┌─────────────┐    ┌─────────────┐      │
│   │ Preprocessor │───▶│  Embedder   │───▶│  Vectorize  │      │
│   └─────────────┘    └─────────────┘    └─────────────┘      │
│                                                              │
│     RPC: embed(), query(), stats()                           │
└───────────────────────────────────────────────────────────────┘
                          │
                          ▼
                    ┌─────────────┐
                    │ Monitoring  │
                    │ & Logging   │
                    └─────────────┘
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

   # Verify index creation
   wrangler vectorize describe dome-notes

   # For staging/production, see MIGRATION.md
   ```

3. **Create queues**:

   ```bash
   # Create development queues
   wrangler queues create embed-queue
   wrangler queues create embed-dead-letter

   # Verify queue creation
   wrangler queues list
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

For staging environments:

```toml
[[services]]
binding   = "CONSTELLATION"
service   = "constellation"
environment = "staging"
```

### Enqueuing Jobs for Async Embedding

The recommended approach for embedding is to enqueue jobs for asynchronous processing:

```typescript
// Enqueue a job for async embedding
await env.QUEUE.send('embed-queue', {
  userId: 'user123',
  noteId: 'note456',
  text: 'This is the text to embed',
  created: Date.now(),
  version: 1,
});

// With error handling
try {
  await env.QUEUE.send('embed-queue', {
    userId: 'user123',
    noteId: 'note456',
    text: 'This is the text to embed',
    created: Date.now(),
    version: 1,
  });
  console.log('Job enqueued successfully');
} catch (error) {
  console.error('Failed to enqueue job:', error);
  // Implement fallback strategy if needed
}
```

### Direct Embedding (Rare)

For testing or low-volume scenarios, you can embed directly:

```typescript
// Directly embed a note (synchronous, use sparingly)
try {
  await env.CONSTELLATION.embed({
    userId: 'user123',
    noteId: 'note456',
    text: 'This is the text to embed',
    created: Date.now(),
    version: 1,
  });
  console.log('Note embedded successfully');
} catch (error) {
  console.error('Failed to embed note:', error);
}
```

### Vector Search

Search for similar vectors with optional filtering:

```typescript
// Basic search
const results = await env.CONSTELLATION.query('Search query text');

// Search with user filter and custom result count
const results = await env.CONSTELLATION.query(
  'Search query text',
  { userId: 'user123' }, // Optional filter
  10, // Optional topK
);

// Process results
for (const result of results) {
  console.log(`Note ${result.metadata.noteId} matched with score ${result.score}`);
}

// Handle empty results
if (results.length === 0) {
  console.log('No matching results found');
}
```

#### Public vs. Private Vectors

The service supports both user-specific (private) and public vectors through a special handling of the `userId` field:

1. When storing vectors:
   ```typescript
   // For private vectors
   const metadata = {
     userId: 'user123',
     // other metadata...
   };
   
   // For public vectors
   const metadata = {
     userId: 'public', // Special sentinel value
     // other metadata...
   };
   ```

2. When querying:
   ```typescript
   // The service automatically includes both user-specific and public vectors
   // by transforming { userId: 'user123' } into { userId: { $in: ['user123', 'public'] } }
   const results = await env.CONSTELLATION.query(
     'Search query text',
     { userId: 'user123' },
     10
   );
   ```

This approach ensures that:
- Private vectors are only accessible to their owners
- Public vectors are accessible to everyone
- No special handling is needed in the client code

> **Note**: This requires a metadata index on the `userId` field, which is created during setup.

### Stats

Retrieve statistics about the vector index:

```typescript
// Get index statistics
try {
  const stats = await env.CONSTELLATION.stats();
  console.log(`Vector index has ${stats.vectors} vectors with dimension ${stats.dimension}`);

  // Check if index is empty
  if (stats.vectors === 0) {
    console.log('Vector index is empty');
  }
} catch (error) {
  console.error('Failed to retrieve index stats:', error);
}
```

## Configuration

### Environment Variables

- `VERSION`: Service version (e.g., "1.0.0")
- `ENVIRONMENT`: Deployment environment ("development", "staging", "production")
- `LOG_LEVEL`: Logging level ("debug", "info", "warn", "error")
- `PREPROCESSOR_CHUNK_SIZE`: Maximum chunk size for text preprocessing (default: 512)
- `PREPROCESSOR_CHUNK_OVERLAP`: Overlap between chunks (default: 50)

### Bindings

- `VECTORIZE`: Vectorize index binding
- `AI`: Workers AI binding
- `embed-queue`: Queue for embedding jobs
- `EMBED_DEAD`: Dead letter queue for failed jobs

### Environment-Specific Configuration

The `wrangler.toml` file contains environment-specific configurations for:

- **Development**: Local development with minimal concurrency

  ```toml
  [env.development.queues]
  consumers = [
    { queue = "embed-queue", max_batch_size = 10, max_concurrency = 1 }
  ]
  ```

- **Staging**: Testing environment with moderate concurrency

  ```toml
  [env.staging.queues]
  consumers = [
    { queue = "embed-queue-staging", max_batch_size = 15, max_concurrency = 5 }
  ]
  ```

- **Production**: Production environment with higher concurrency and batch sizes
  ```toml
  [env.production.queues]
  consumers = [
    { queue = "embed-queue-prod", max_batch_size = 20, max_concurrency = 10 }
  ]
  ```

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

4. Run tests with coverage:

   ```bash
   pnpm test:coverage
   ```

5. Lint code:
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
   wrangler queues publish embed-queue '{"userId":"test123","noteId":"note123","text":"This is a test note for embedding","created":1650000000000,"version":1}'
   ```

3. Check the logs to verify processing:

   ```bash
   # In a separate terminal
   wrangler tail
   ```

4. Test the RPC interface directly:

   ```bash
   # Get stats
   curl "http://localhost:8787/stats"

   # Perform a query
   curl -X POST "http://localhost:8787/query" \
     -H "Content-Type: application/json" \
     -d '{"text":"test query","filter":{"userId":"test123"},"topK":5}'
   ```

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
# Deploy to staging
wrangler deploy --env staging

# Deploy to production
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

### Logging

Constellation uses structured logging with the following levels:

- `debug`: Detailed information for debugging
- `info`: General operational information
- `warn`: Warning conditions that should be addressed
- `error`: Error conditions that require attention

Example log output:

```json
{
  "level": "info",
  "message": "Processing embedding batch",
  "timestamp": "2025-04-18T19:12:45.123Z",
  "batchSize": 10,
  "environment": "production",
  "service": "constellation"
}
```

### Alerts

Alert configurations are defined in `monitoring/alerts.yaml`. These alerts can be integrated with:

- Email notifications
- Slack channels
- PagerDuty

Example alert configuration:

```yaml
- name: high-queue-depth
  description: 'High queue depth detected'
  metric: 'queue_depth'
  threshold: 1000
  duration: '15m'
  severity: 'warning'
  notification:
    channels: ['slack-alerts', 'email-ops']
```

## Error Handling

Constellation implements several error handling strategies:

1. **Retries**: Failed operations are retried with exponential backoff.

   ```typescript
   // Example retry logic
   let attempt = 0;
   while (attempt < maxRetries) {
     try {
       await operation();
       break;
     } catch (error) {
       attempt++;
       if (attempt >= maxRetries) throw error;
       await delay(retryDelay * Math.pow(2, attempt - 1));
     }
   }
   ```

2. **Dead Letter Queue**: Persistently failed jobs are sent to a dead letter queue.

   ```typescript
   // Example dead letter queue handling
   try {
     await processJob(job);
   } catch (error) {
     await env.EMBED_DEAD.send({
       job,
       error: error.message,
       attempts: message.attempts,
       timestamp: Date.now(),
     });
   }
   ```

3. **Batch Retries**: Entire batches can be retried if needed.

4. **Structured Error Logging**: Errors are logged with context for debugging.
   ```typescript
   // Example error logging
   logger.error(
     {
       error,
       jobId: job.noteId,
       userId: job.userId,
       attempts: message.attempts,
     },
     'Failed to process embedding job',
   );
   ```

## Performance Considerations

- **Batch Size**: The queue consumer is configured for batches of 10-20 jobs depending on environment.

  - Development: 10 jobs per batch
  - Staging: 15 jobs per batch
  - Production: 20 jobs per batch

- **Embedding Limits**: Workers AI has a limit of 20 texts per embedding call.

  - Each text should be ≤ 8 kB for optimal performance
  - Longer texts are automatically chunked by the preprocessor

- **Vectorize Limits**: Vectorize has a recommended batch size of 100 vectors.

  - The service automatically batches vector operations to stay within limits
  - Each vector has a dimension of 384 (for text-embedding-3-small)

- **Text Size**: Text should be ≤ 8 kB for optimal performance.

  - Longer texts will be automatically chunked
  - Very large texts (> 100 kB) may be rejected

- **Concurrency**: Production is configured with higher concurrency (10) than staging (5) or development (1).
  - This affects how many batches can be processed simultaneously

## Migration

For detailed instructions on migrating from the previous embedding approach to Constellation, see [MIGRATION.md](./MIGRATION.md).

## Troubleshooting

### Common Issues

1. **High Queue Depth**:

   - **Symptoms**: Increasing number of messages in the queue, slow processing
   - **Causes**:
     - Workers AI rate limits being hit
     - Insufficient concurrency settings
     - Vectorize index performance issues
   - **Solutions**:
     - Check Workers AI rate limits in Cloudflare dashboard
     - Increase `max_concurrency` in wrangler.toml
     - Verify Vectorize index is functioning properly
     - Consider increasing batch size for more efficient processing

2. **Embedding Errors**:

   - **Symptoms**: Errors in logs, messages going to dead letter queue
   - **Causes**:
     - Workers AI service unavailability
     - Malformed input data
     - Text preprocessing issues
   - **Solutions**:
     - Check Workers AI service status in Cloudflare dashboard
     - Verify text preprocessing is working correctly
     - Check for malformed input data
     - Review error logs for specific error types

3. **Query Performance Issues**:
   - **Symptoms**: Slow query responses, timeouts
   - **Causes**:
     - Missing metadata filters
     - Large index size
     - Network latency
   - **Solutions**:
     - Use metadata filters to narrow search scope
     - Verify index size and dimension
     - Check for slow network conditions
     - Consider optimizing query text preprocessing

### Debugging

1. **View logs in real-time**:

   ```bash
   # Development
   wrangler tail

   # Staging
   wrangler tail constellation --env staging

   # Production
   wrangler tail constellation --env production
   ```

2. **Check dead letter queue**:

   ```bash
   # Development
   wrangler queues list-messages embed-dead-letter

   # Staging
   wrangler queues list-messages embed-dead-letter-staging

   # Production
   wrangler queues list-messages embed-dead-letter-prod
   ```

3. **Test RPC methods directly**:

   ```bash
   # Development
   curl "http://localhost:8787/stats"

   # Production
   curl "https://constellation.example.com/stats"
   ```

4. **Inspect Vectorize index**:

   ```bash
   # Get index details
   wrangler vectorize describe dome-notes-prod

   # List vectors (sample)
   wrangler vectorize list-vectors dome-notes-prod --limit 10
   ```

## API Reference

For detailed API documentation, see [API.md](./API.md).
