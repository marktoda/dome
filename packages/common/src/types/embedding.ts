/**
 * Common types for the Constellation embedding service
 *
 * This file defines the core data structures used throughout the Constellation service,
 * including job definitions, metadata structures, search results, and statistics.
 * These types are shared between the service and its clients.
 */

import { ContentCategory, MimeType } from './siloContent';

/**
 * Vector metadata structure
 * Contains the metadata associated with each vector in the Vectorize index
 */
export interface VectorMeta {
  userId: string;
  contentId: string;
  category: ContentCategory;
  mimeType: MimeType;
  createdAt: number;
  version: number;
}

/**
 * Vector search result
 * Represents a single result from a vector similarity search operation
 */
export interface VectorSearchResult {
  id: string;
  score: number;
  metadata: VectorMeta;
}

/**
 * Vector index statistics
 *
 * Contains information about the current state of the vector index.
 * Used for monitoring and diagnostics.
 *
 * @property vectors - Total number of vectors stored in the index
 * @property dimension - Dimension of the vectors in the index (e.g., 384 for text-embedding-3-small)
 */
export interface VectorIndexStats {
  vectors: number;
  dimension: number;
}
