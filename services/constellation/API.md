# Constellation API Documentation

This document provides detailed information about the Constellation service API, including RPC methods, data types, and usage examples.

## RPC Methods

The Constellation service exposes the following RPC methods through service binding:

### `embed(job: EmbedJob): Promise<void>`

Embeds a single note immediately. This is a synchronous operation and should be used sparingly, primarily for testing or low-volume scenarios.

**Parameters:**
- `job: EmbedJob` - The embedding job to process

**Returns:**
- `Promise<void>` - A promise that resolves when the embedding is complete

**Example:**
```typescript
await env.CONSTELLATION.embed({
  userId: 'user123',
  noteId: 'note456',
  text: 'This is the text to embed',
  created: Date.now(),
  version: 1
});
```

### `query(text: string, filter?: Partial<NoteVectorMeta>, topK?: number): Promise<VectorSearchResult[]>`

Performs a vector similarity search using the provided query text and optional filters.

**Parameters:**
- `text: string` - The query text to search for
- `filter?: Partial<NoteVectorMeta>` - Optional metadata filter to restrict results
- `topK?: number` - Optional number of results to return (default: 10)

**Returns:**
- `Promise<VectorSearchResult[]>` - A promise that resolves to an array of search results

**Example:**
```typescript
// Search for similar vectors with a filter
const results = await env.CONSTELLATION.query(
  'Search query text',
  { userId: 'user123' },
  10
);

// Process results
for (const result of results) {
  console.log(`Note ${result.metadata.noteId} matched with score ${result.score}`);
}
```

### `stats(): Promise<VectorIndexStats>`

Retrieves statistics about the vector index.

**Parameters:**
- None

**Returns:**
- `Promise<VectorIndexStats>` - A promise that resolves to the vector index statistics

**Example:**
```typescript
const stats = await env.CONSTELLATION.stats();
console.log(`Vector index has ${stats.vectors} vectors with dimension ${stats.dimension}`);
```

## Data Types

### `EmbedJob`

Represents a job for embedding a text document.

```typescript
interface EmbedJob {
  userId: string;       // User ID associated with the note
  noteId: string;       // Unique identifier for the note
  text: string;         // Text content to embed (≤ 8 kB preferred)
  created: number;      // Creation timestamp (ms since epoch)
  version: number;      // Embedding version
}
```

### `NoteVectorMeta`

Metadata associated with a vector in the index.

```typescript
interface NoteVectorMeta {
  userId: string;       // User ID associated with the note
  noteId: string;       // Unique identifier for the note
  createdAt: number;    // Creation timestamp (s since epoch)
  version: number;      // Embedding version
}
```

### `VectorSearchResult`

Result from a vector similarity search.

```typescript
interface VectorSearchResult {
  id: string;           // Vector ID (format: note:{noteId}:{chunkIndex})
  score: number;        // Similarity score (0-1, higher is more similar)
  metadata: NoteVectorMeta; // Associated metadata
}
```

### `VectorIndexStats`

Statistics about the vector index.

```typescript
interface VectorIndexStats {
  vectors: number;      // Number of vectors in the index
  dimension: number;    // Dimension of the vectors
}
```

## Queue Consumer

In addition to the RPC methods, Constellation also acts as a queue consumer for the `EMBED_QUEUE`. This allows for asynchronous processing of embedding jobs.

### Enqueuing Jobs

To enqueue a job for asynchronous processing:

```typescript
await env.QUEUE.send('EMBED_QUEUE', {
  userId: 'user123',
  noteId: 'note456',
  text: 'This is the text to embed',
  created: Date.now(),
  version: 1
} satisfies EmbedJob);
```

### Queue Processing

The queue consumer:
1. Processes batches of up to 10 jobs at a time
2. Preprocesses text (normalizes and chunks if necessary)
3. Generates embeddings using Workers AI
4. Stores vectors in the Vectorize index
5. Handles errors and retries as needed

## Error Handling

The service implements robust error handling:

- **Retries**: Failed operations are retried with exponential backoff
- **Dead Letter Queue**: Persistently failed jobs are sent to the `EMBED_DEAD` queue
- **Structured Error Logging**: Errors are logged with context for debugging

## Performance Considerations

- **Batch Size**: The queue consumer is configured for batches of 10 jobs
- **Embedding Limits**: Workers AI has a limit of 20 texts per embedding call
- **Vectorize Limits**: Vectorize has a recommended batch size of 100 vectors
- **Text Size**: Text should be ≤ 8 kB for optimal performance
- **Query Filters**: Using metadata filters can significantly improve query performance

## Versioning

The `version` field in `EmbedJob` and `NoteVectorMeta` allows for managing different embedding models or configurations over time. When upgrading the embedding model:

1. Increment the version number in new embedding jobs
2. The service will store the new embeddings with the updated version
3. Queries can filter by version to target specific embedding generations