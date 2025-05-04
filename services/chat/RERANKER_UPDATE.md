# Reranker Node Update

## Changes Summary

The unified reranker node has been updated to follow a more efficient and flexible approach:

1. **Changed data source**: Now using `state.retrievals` instead of the deprecated `retrievalResults`
2. **Group-based reranking**: Reranking each retrieval group separately for better relevance
3. **Removed category-specific filtering**: Using a single reranker configuration for all content types
4. **Improved type handling**: Added type assertions to fix TypeScript errors and improve code reliability

## Implementation Details

### 1. Data Source Change

The reranker now consumes retrieval results from the new standardized location using the correct shape:

```typescript
// Old approach (deprecated)
const retrievalResults = state.retrievalResults || {};

// New approach - array of RetrievalTask objects
const retrievals = (state as any).retrievals || [];
```

### 2. Task-Based Reranking

Instead of having separate rerankers for different content categories (code, docs, notes), we now:

- Process each retrieval task independently
- Apply the same reranker to all retrieval tasks
- Return results as an array of reranked tasks

This new approach correctly handles the retrieval task structure:

```typescript
// RetrievalTask structure
interface RetrievalTask {
  category: string;        // e.g., 'code', 'docs', 'web'
  query: string;           // The query used for retrieval
  chunks?: DocumentChunk[]; // The retrieved document chunks
  sourceType?: string;     // Source type information
  metadata?: {...};        // Additional metadata
}
```

This provides better organization of results while maintaining the ability to rerank different content types separately.

### 3. Simplified Configuration and Workers AI Integration

Replaced category-specific models and thresholds, and integrated with Workers AI:

```typescript
// Old approach - different settings per category
const RERANKER_MODELS = {
  code: 'bge-reranker-code',
  docs: 'bge-reranker-docs',
  notes: 'bge-reranker-notes',
};
const SCORE_THRESHOLDS = { code: 0.25, docs: 0.22, notes: 0.2 };
const MAX_CHUNKS = { code: 8, docs: 8, notes: 8 };

// New approach - single configuration
const RERANKER_MODEL = 'bge-reranker-base';
const SCORE_THRESHOLD = 0.2;
const MAX_CHUNKS = 10;
```

This simplifies code maintenance while still allowing for effective reranking.

### 4. Real Reranking with Workers AI

Replaced the simulated reranking with actual Workers AI reranking:

```typescript
// Old approach - simulation
const rerankedChunks = await simulateReranking(
  retrievalResult.chunks,
  query,
  retrievalResult.sourceType,
  model,
);

// New approach - actual Workers AI reranking
const rerankedChunks = await rerankWithWorkersAI(retrievalResult.chunks, query, model, env);
```

The new implementation:

- Makes a proper call to Workers AI reranking model
- Uses the `@cf/baai/bge-reranker-base` model for high quality relevance assessment
- Processes document chunks in batches with the query
- Returns real relevance scores based on cross-encoder assessment
- Falls back gracefully if the AI service encounters any issues

### 4. Consistent Return Format

The reranker now returns results in a consistent format that preserves the structure of the input:

```typescript
return {
  rerankedResults: allRerankedResults, // Organized by the same keys as input
  metadata: {
    currentNode: nodeId,
    executionTimeMs: elapsed,
    nodeTimings: {
      ...state.metadata?.nodeTimings,
      [nodeId]: elapsed,
    },
  },
};
```

## Performance Improvements

1. **Reduced Duplicate Processing**: Each retrieval group is processed exactly once
2. **More Inclusive Results**: Using a lower threshold (0.2) and higher max chunks (10) to ensure more diverse content
3. **Better Type Safety**: More robust error handling with proper type assertions
4. **Actual AI-powered Reranking**: Using Workers AI for high-quality relevance scoring

## Handling Duplicate Retrieval Tasks

The reranker now properly handles duplicate retrieval tasks that might occur between the retrieve and rerank nodes:

```typescript
// Example duplicated retrieval tasks
retrievals: [
  {
    chunks: [], // Empty chunks
    query: "some query",
    category: "note"
  },
  {
    query: "some query", // Same query and category
    category: "note",
    chunks: [
      { id: "...", source: "...", ... }, // But this one has chunks
      { id: "...", source: "...", ... }
    ]
  }
]
```

The reranker:

- Identifies duplicate tasks based on category+query
- Merges their chunks into a single task
- Logs detailed information about the merge process
- Processes the deduplicated list of tasks

This ensures that all retrieved content is properly considered without duplication.

## Backward Compatibility

For backward compatibility, the category-specific reranker exports are maintained:

```typescript
export const codeReranker = createCategoryReranker();
export const docsReranker = createCategoryReranker();
export const notesReranker = createCategoryReranker();
```

These all use the unified implementation under the hood, ensuring consistent behavior across the codebase.
