import type {
  MessageData,
  EmbedJob,
  NoteVectorMeta,
  VectorSearchResult,
  VectorIndexStats,
} from '@dome/common';

/**
 * Interface for Workers AI binding
 */
interface WorkersAI {
  run(model: string, options: any): Promise<any>;
}

/**
 * Interface for Constellation service binding
 */
export interface ConstellationService {
  /**
   * Embed a single note immediately (synchronous, use sparingly)
   */
  embed(job: EmbedJob): Promise<void>;

  /**
   * Perform a vector similarity search
   */
  query(
    text: string,
    filter?: Partial<NoteVectorMeta>,
    topK?: number,
  ): Promise<VectorSearchResult[]>;

  /**
   * Get statistics about the vector index
   */
  stats(): Promise<VectorIndexStats>;
}

export type Bindings = {
  D1_DATABASE: D1Database;
  VECTORIZE: VectorizeIndex;
  RAW: R2Bucket;
  EVENTS: Queue<MessageData>;
  EMBED_QUEUE: Queue<EmbedJob>;
  AI?: WorkersAI; // Optional to support testing environments
  CONSTELLATION?: ConstellationService; // Optional to support testing environments
};
