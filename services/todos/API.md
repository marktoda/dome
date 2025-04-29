# Constellation API Documentation

This document provides detailed information about the Constellation service API, including RPC methods, data types, usage examples, and best practices.

## Overview

Constellation provides a typed RPC interface for other workers to interact with the embedding and vector search functionality. The service is designed to be used as a service binding in other Cloudflare Workers.

## Service Binding Setup

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

## RPC Methods

The Constellation service exposes the following RPC methods through service binding:

### `embed(job: EmbedJob): Promise<void>`

Embeds a single note immediately. This is a synchronous operation and should be used sparingly, primarily for testing or low-volume scenarios.

**Parameters:**

- `job: EmbedJob` - The embedding job to process
  - `userId: string` - User ID associated with the note
  - `noteId: string` - Unique identifier for the note
  - `text: string` - Text content to embed (≤ 8 kB preferred)
  - `created: number` - Creation timestamp (ms since epoch)
  - `version: number` - Embedding version

**Returns:**

- `Promise<void>` - A promise that resolves when the embedding is complete

**Error Handling:**

- Throws if the text is empty or exceeds size limits
- Throws if the embedding operation fails after retries
- Throws if the vector storage operation fails after retries

**Example:**

```typescript
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

### `query(text: string, filter?: Partial<NoteVectorMeta>, topK?: number): Promise<VectorSearchResult[]>`

Performs a vector similarity search using the provided query text and optional filters.

**Parameters:**

- `text: string` - The query text to search for
- `filter?: Partial<NoteVectorMeta>` - Optional metadata filter to restrict results
  - `userId?: string` - Filter by user ID
  - `noteId?: string` - Filter by note ID
  - `version?: number` - Filter by embedding version
- `topK?: number` - Optional number of results to return (default: 10)

**Returns:**

- `Promise<VectorSearchResult[]>` - A promise that resolves to an array of search results
  - Each result contains:
    - `id: string` - Vector ID (format: note:{noteId}:{chunkIndex})
    - `score: number` - Similarity score (0-1, higher is more similar)
    - `metadata: NoteVectorMeta` - Associated metadata

**Error Handling:**

- Returns an empty array if the query text is empty
- Throws if the embedding operation fails
- Throws if the vector search operation fails after retries

**Example:**

```typescript
// Search for similar vectors with a filter
try {
  const results = await env.CONSTELLATION.query('Search query text', { userId: 'user123' }, 10);

  // Process results
  for (const result of results) {
    console.log(`Note ${result.metadata.noteId} matched with score ${result.score}`);
  }

  // No results case
  if (results.length === 0) {
    console.log('No matching results found');
  }
} catch (error) {
  console.error('Search failed:', error);
}
```

### `stats(): Promise<VectorIndexStats>`

Retrieves statistics about the vector index.

**Parameters:**

- None

**Returns:**

- `Promise<VectorIndexStats>` - A promise that resolves to the vector index statistics
  - `vectors: number` - Number of vectors in the index
  - `dimension: number` - Dimension of the vectors

**Error Handling:**

- Throws if unable to retrieve index statistics

**Example:**

```typescript
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

## Data Types

### `EmbedJob`

Represents a job for embedding a text document.

```typescript
interface EmbedJob {
  userId: string; // User ID associated with the note
  noteId: string; // Unique identifier for the note
  text: string; // Text content to embed (≤ 8 kB preferred)
  created: number; // Creation timestamp (ms since epoch)
  version: number; // Embedding version
}
```

**Field Details:**

- `userId`: String identifier for the user who owns the note
- `noteId`: Unique identifier for the note being embedded
- `text`: The text content to embed (should be ≤ 8 kB for optimal performance)
- `created`: Creation timestamp in milliseconds since epoch
- `version`: Embedding model/algorithm version, used for managing model upgrades

### `NoteVectorMeta`

Metadata associated with a vector in the index.

```typescript
interface NoteVectorMeta {
  userId: string; // User ID associated with the note
  noteId: string; // Unique identifier for the note
  createdAt: number; // Creation timestamp (s since epoch)
  version: number; // Embedding version
}
```

**Field Details:**

- `userId`: String identifier for the user who owns the note
- `noteId`: Unique identifier for the note
- `createdAt`: Creation timestamp in seconds since epoch
- `version`: Embedding model/algorithm version

**Note:** The `createdAt` field is in seconds since epoch, while the `created` field in `EmbedJob` is in milliseconds. The service handles this conversion internally.

### `VectorSearchResult`

Result from a vector similarity search.

```typescript
interface VectorSearchResult {
  id: string; // Vector ID (format: note:{noteId}:{chunkIndex})
  score: number; // Similarity score (0-1, higher is more similar)
  metadata: NoteVectorMeta; // Associated metadata
}
```

**Field Details:**

- `id`: Vector identifier in the format "note:{noteId}:{chunkIndex}"
- `score`: Similarity score between 0 and 1, where higher values indicate greater similarity
- `metadata`: Associated metadata for the vector, including user and note information

### `VectorIndexStats`

Statistics about the vector index.

```typescript
interface VectorIndexStats {
  vectors: number; // Number of vectors in the index
  dimension: number; // Dimension of the vectors
}
```

**Field Details:**

- `vectors`: Total number of vectors stored in the index
- `dimension`: Dimension of the vectors in the index (e.g., 384 for text-embedding-3-small)

## Queue Consumer

In addition to the RPC methods, Constellation also acts as a queue consumer for the `embed-queue`. This allows for asynchronous processing of embedding jobs.

### Enqueuing Jobs

To enqueue a job for asynchronous processing:

```typescript
// Enqueue a job for async embedding
await env.QUEUE.send('embed-queue', {
  userId: 'user123',
  noteId: 'note456',
  text: 'This is the text to embed',
  created: Date.now(),
  version: 1,
} satisfies EmbedJob);
```

For production environments, use the appropriate queue name:

```typescript
// Production queue
await env.QUEUE.send('embed-queue-prod', {
  /* job data */
});

// Staging queue
await env.QUEUE.send('embed-queue-staging', {
  /* job data */
});
```

### Queue Processing

The queue consumer:

1. Processes batches of jobs (10-20 depending on environment)
2. Preprocesses text (normalizes and chunks if necessary)
3. Generates embeddings using Workers AI
4. Stores vectors in the Vectorize index
5. Handles errors and retries as needed

### Queue Processing Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Receive    │     │ Preprocess  │     │  Generate   │     │   Store     │
│  Batch      │────▶│    Text     │────▶│ Embeddings  │────▶│  Vectors    │
│             │     │             │     │             │     │             │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
       │                   │                   │                   │
       │                   │                   │                   │
       ▼                   ▼                   ▼                   ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Retry     │     │   Retry     │     │   Retry     │     │   Retry     │
│  Logic      │     │  Logic      │     │  Logic      │     │  Logic      │
│             │     │             │     │             │     │             │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
       │                   │                   │                   │
       └───────────────────┴───────────────────┴───────────────────┘
                                     │
                                     ▼
                            ┌─────────────────┐
                            │  Dead Letter    │
                            │     Queue       │
                            │                 │
                            └─────────────────┘
```

## Error Handling

The service implements robust error handling:

- **Retries**: Failed operations are retried with exponential backoff

  - Embedding operations: 3 retries with 1s initial delay
  - Vector storage operations: 3 retries with 1s initial delay
  - Queue processing: Automatic retries based on queue configuration

- **Dead Letter Queue**: Persistently failed jobs are sent to the `EMBED_DEAD` queue

  - Production: `embed-dead-letter-prod`
  - Staging: `embed-dead-letter-staging`
  - Development: `embed-dead-letter`

- **Structured Error Logging**: Errors are logged with context for debugging
  - All errors include operation context, input parameters, and error details
  - Error logs are tagged with appropriate metadata for filtering

### Common Error Scenarios

1. **Text Too Large**: If text exceeds size limits, it will be chunked or rejected
2. **Workers AI Unavailable**: If the embedding service is unavailable, jobs will be retried
3. **Vectorize Index Issues**: If vector storage fails, operations will be retried
4. **Malformed Input**: If input data is malformed, detailed error logs will be generated

## Performance Considerations

- **Batch Size**: The queue consumer is configured for batches of 10-20 jobs depending on environment

  - Development: 10 jobs per batch
  - Staging: 15 jobs per batch
  - Production: 20 jobs per batch

- **Embedding Limits**: Workers AI has a limit of 20 texts per embedding call

  - Each text should be ≤ 8 kB for optimal performance
  - Longer texts are automatically chunked by the preprocessor

- **Vectorize Limits**: Vectorize has a recommended batch size of 100 vectors

  - The service automatically batches vector operations to stay within limits
  - Each vector has a dimension of 384 (for text-embedding-3-small)

- **Text Size**: Text should be ≤ 8 kB for optimal performance

  - Longer texts will be automatically chunked
  - Very large texts (> 100 kB) may be rejected

- **Query Filters**: Using metadata filters can significantly improve query performance

  - Always filter by `userId` when possible
  - Consider filtering by `version` when working with multiple embedding versions

- **Concurrency**: Production is configured with higher concurrency (10) than staging (5) or development (1)
  - This affects how many batches can be processed simultaneously

## Versioning

The `version` field in `EmbedJob` and `NoteVectorMeta` allows for managing different embedding models or configurations over time. When upgrading the embedding model:

1. Increment the version number in new embedding jobs
2. The service will store the new embeddings with the updated version
3. Queries can filter by version to target specific embedding generations

### Version Migration Strategy

When migrating to a new embedding version:

1. Start sending new jobs with the incremented version number
2. For queries, initially filter by the old version to ensure consistent results
3. Gradually transition to querying both versions
4. Once sufficient data is available with the new version, switch queries to the new version only

Example:

```typescript
// During migration, query both versions
const oldResults = await env.CONSTELLATION.query(text, { userId, version: 1 });
const newResults = await env.CONSTELLATION.query(text, { userId, version: 2 });

// Combine and process results
const combinedResults = [...oldResults, ...newResults]
  .sort((a, b) => b.score - a.score)
  .slice(0, 10);
```

## Request/Response Examples

### Example 1: Embedding a Note

**Request:**

```typescript
await env.CONSTELLATION.embed({
  userId: 'user123',
  noteId: 'note456',
  text: 'This is a sample note with content to be embedded for vector search.',
  created: 1650000000000,
  version: 1,
});
```

**Response:**

```
// No response body (void)
// Success is indicated by no error being thrown
```

### Example 2: Querying Similar Notes

**Request:**

```typescript
const results = await env.CONSTELLATION.query(
  'Find notes about vector search',
  { userId: 'user123' },
  5,
);
```

**Response:**

```json
[
  {
    "id": "note:note456:0",
    "score": 0.92,
    "metadata": {
      "userId": "user123",
      "noteId": "note456",
      "createdAt": 1650000000,
      "version": 1
    }
  },
  {
    "id": "note:note789:0",
    "score": 0.85,
    "metadata": {
      "userId": "user123",
      "noteId": "note789",
      "createdAt": 1649000000,
      "version": 1
    }
  }
  // Additional results...
]
```

### Example 3: Getting Index Statistics

**Request:**

```typescript
const stats = await env.CONSTELLATION.stats();
```

**Response:**

```json
{
  "vectors": 10250,
  "dimension": 384
}
```

## Best Practices

1. **Use Asynchronous Embedding**: Prefer enqueuing jobs over direct embedding for better performance and reliability
2. **Apply Metadata Filters**: Always use metadata filters in queries to improve performance and relevance
3. **Handle Empty Results**: Always check for empty result arrays in your query handlers
4. **Implement Error Handling**: Wrap API calls in try/catch blocks to handle potential errors
5. **Monitor Queue Depth**: Keep an eye on queue depth to detect processing bottlenecks
6. **Optimize Text Size**: Keep text chunks under 8 kB for optimal embedding performance
7. **Use Version Filtering**: When migrating embedding models, use version filtering to ensure consistent results
