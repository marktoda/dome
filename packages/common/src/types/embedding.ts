/**
 * Common types for the Constellation embedding service
 */

/**
 * Job structure for embedding queue messages
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
 */
export interface NoteVectorMeta {
  userId: string;
  noteId: string;
  createdAt: number; // s since epoch
  version: number;
}

/**
 * Vector search result
 */
export interface VectorSearchResult {
  id: string;
  score: number;
  metadata: NoteVectorMeta;
}

/**
 * Vector index statistics
 */
export interface VectorIndexStats {
  vectors: number;
  dimension: number;
}