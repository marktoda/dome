/**
 * Common types for the Constellation embedding service
 *
 * This file defines the core data structures used throughout the Constellation service,
 * including job definitions, metadata structures, search results, and statistics.
 * These types are shared between the service and its clients.
 */

/**
 * Job structure for embedding queue messages
 *
 * Represents a single text embedding job that can be sent to the embedding queue
 * or processed directly by the Constellation service.
 *
 * @property userId - Identifier for the user who owns the note
 * @property noteId - Unique identifier for the note being embedded
 * @property text - The text content to embed (should be ≤ 8 kB for optimal performance)
 * @property created - Creation timestamp in milliseconds since epoch
 * @property version - Embedding model/algorithm version, used for managing model upgrades
 *
 * @example
 * ```typescript
 * const job: EmbedJob = {
 *   userId: 'user123',
 *   noteId: 'note456',
 *   text: 'This is the text content to embed',
 *   created: Date.now(),
 *   version: 1
 * };
 * ```
 */
export interface EmbedJob {
  userId: string;
  noteId: string;
  text: string; // ≤ 8 kB preferred
  created: number; // ms since epoch
  version: number; // embedding version
}

/**
 * Metadata structure for vector storage
 *
 * Contains the metadata associated with each vector in the Vectorize index.
 * This metadata is used for filtering and identifying vectors during queries.
 *
 * @property userId - Identifier for the user who owns the note
 * @property noteId - Unique identifier for the note
 * @property createdAt - Creation timestamp in seconds since epoch
 * @property version - Embedding model/algorithm version
 *
 * @example
 * ```typescript
 * const metadata: NoteVectorMeta = {
 *   userId: 'user123',
 *   noteId: 'note456',
 *   createdAt: Math.floor(Date.now() / 1000),
 *   version: 1
 * };
 * ```
 */
export interface NoteVectorMeta {
  userId: string;
  noteId: string;
  createdAt: number; // s since epoch
  version: number;
}

/**
 * Vector search result
 *
 * Represents a single result from a vector similarity search operation.
 * Results are typically sorted by score in descending order (highest similarity first).
 *
 * @property id - Vector identifier in the format "note:{noteId}:{chunkIndex}"
 * @property score - Similarity score between 0 and 1, where higher values indicate greater similarity
 * @property metadata - Associated metadata for the vector, including user and note information
 *
 * @example
 * ```typescript
 * const result: VectorSearchResult = {
 *   id: 'note:note456:0',
 *   score: 0.92,
 *   metadata: {
 *     userId: 'user123',
 *     noteId: 'note456',
 *     createdAt: 1650000000,
 *     version: 1
 *   }
 * };
 * ```
 */
export interface VectorSearchResult {
  id: string;
  score: number;
  metadata: NoteVectorMeta;
}

/**
 * Vector index statistics
 *
 * Contains information about the current state of the vector index.
 * Used for monitoring and diagnostics.
 *
 * @property vectors - Total number of vectors stored in the index
 * @property dimension - Dimension of the vectors in the index (e.g., 384 for text-embedding-3-small)
 *
 * @example
 * ```typescript
 * const stats: VectorIndexStats = {
 *   vectors: 10250,
 *   dimension: 384
 * };
 * ```
 */
export interface VectorIndexStats {
  vectors: number;
  dimension: number;
}
