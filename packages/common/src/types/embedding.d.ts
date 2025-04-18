/**
 * Common types for the Constellation embedding service
 */
/**
 * Job structure for embedding queue messages
 */
export interface EmbedJob {
  userId: string;
  noteId: string;
  text: string;
  created: number;
  version: number;
}
/**
 * Metadata structure for vector storage
 */
export interface NoteVectorMeta {
  userId: string;
  noteId: string;
  createdAt: number;
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
