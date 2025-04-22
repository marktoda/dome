import type {
  MessageData,
  SiloEmbedJob,
  VectorMeta,
  VectorSearchResult,
  VectorIndexStats,
  SiloSimplePutInput,
  SiloBatchGetInput,
  SiloDeleteInput,
  SiloStatsInput,
  SiloSimplePutResponse,
  SiloBatchGetResponse,
  SiloDeleteResponse,
  SiloStatsResponse,
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
   * Embed a single content item immediately (synchronous, use sparingly)
   */
  embed(job: SiloEmbedJob): Promise<void>;

  /**
   * Perform a vector similarity search
   */
  query(text: string, filter?: Partial<VectorMeta>, topK?: number): Promise<VectorSearchResult[]>;

  /**
   * Get statistics about the vector index
   */
  stats(): Promise<VectorIndexStats>;
}

export interface SiloService {
  batchGet(data: SiloBatchGetInput): Promise<SiloBatchGetResponse>;
  delete(data: SiloDeleteInput): Promise<SiloDeleteResponse>;

  /**
   * Get statistics about the vector index
   */
  stats(data: SiloStatsInput): Promise<SiloStatsResponse>;
}

export type Bindings = {
  D1_DATABASE: D1Database;
  VECTORIZE: VectorizeIndex;
  RAW: R2Bucket;
  EVENTS: Queue<MessageData>;
  EMBED_QUEUE: Queue<SiloEmbedJob>;
  INGEST_QUEUE: Queue<SiloSimplePutInput>; // Queue for content ingestion
  AI?: WorkersAI; // Optional to support testing environments
  CONSTELLATION?: ConstellationService; // Optional to support testing environments
  SILO: SiloService; // Silo service binding
  VERSION?: string; // Version of the service
  ENVIRONMENT?: string; // Environment (development, staging, production)
};
