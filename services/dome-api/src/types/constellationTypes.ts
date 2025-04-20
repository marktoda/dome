/**
 * Type definitions for Constellation service data models
 * These types represent the data structures used by the Constellation service
 */

/**
 * Vector embedding job structure
 * Represents a job to embed text into a vector
 */
export interface ConstellationEmbedJob {
  userId: string;
  noteId: string;
  text: string;
  created: number;
  version: number;
}

/**
 * Vector metadata structure
 * Metadata associated with vectors in the Constellation service
 */
export interface ConstellationVectorMeta {
  userId: string;
  noteId: string;
  createdAt?: number;
}

/**
 * Vector search result structure
 * Represents a result from a vector similarity search
 */
export interface ConstellationVectorSearchResult {
  id: string;
  score: number;
  metadata: ConstellationVectorMeta;
  vector?: number[]; // Optional, may be included in some responses
}

/**
 * Vector index statistics structure
 * Provides statistics about the vector index
 */
export interface ConstellationVectorIndexStats {
  totalVectors: number;
  vectorsByUser: Record<string, number>;
  vectorsByDate: Record<string, number>;
  dimensions: number;
  lastUpdated: number;
}

/**
 * Vector query options structure
 * Options for querying vectors
 */
export interface ConstellationQueryOptions {
  topK?: number;
  filter?: Partial<ConstellationVectorMeta>;
  includeVectors?: boolean;
  includeMetadata?: boolean;
}

/**
 * Vector embedding options structure
 * Options for embedding text
 */
export interface ConstellationEmbeddingOptions {
  model?: string;
  dimensions?: number;
  normalize?: boolean;
}

/**
 * Vector batch operation result
 * Result of a batch operation on vectors
 */
export interface ConstellationBatchResult {
  successful: number;
  failed: number;
  errors?: Record<string, string>;
}

/**
 * Vector deletion options
 * Options for deleting vectors
 */
export interface ConstellationDeleteOptions {
  filter?: Partial<ConstellationVectorMeta>;
  ids?: string[];
}
