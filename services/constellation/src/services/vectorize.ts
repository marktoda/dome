/**
 * Vectorize Service
 *
 * Handles vector storage and retrieval operations.
 */

import { NoteVectorMeta, VectorSearchResult, VectorIndexStats } from '@dome/common';
import { logger } from '../utils/logging';
import { metrics } from '../utils/metrics';
import { VectorWithMetadata } from '../types';

/**
 * Configuration for the vectorize service
 */
export interface VectorizeConfig {
  maxBatchSize: number;
  retryAttempts: number;
  retryDelay: number;
}

/**
 * Default configuration values
 */
export const DEFAULT_VECTORIZE_CONFIG: VectorizeConfig = {
  maxBatchSize: 100, // Vectorize recommended batch size
  retryAttempts: 3,
  retryDelay: 1000, // ms
};

/**
 * Vectorize service for storing and retrieving vector embeddings
 */
export class VectorizeService {
  private config: VectorizeConfig;
  private vectorize: VectorizeIndex;

  constructor(vectorize: VectorizeIndex, config: Partial<VectorizeConfig> = {}) {
    this.vectorize = vectorize;
    this.config = {
      ...DEFAULT_VECTORIZE_CONFIG,
      ...config,
    };
  }

  /**
   * Store vectors in the Vectorize index
   * @param vectors Array of vectors with metadata
   */
  public async upsert(vectors: VectorWithMetadata[]): Promise<void> {
    if (!vectors.length) {
      logger.warn('Empty vectors array provided for upsert');
      return;
    }

    // Track metrics
    metrics.increment('vectorize.upsert.requests');
    metrics.gauge('vectorize.upsert.batch_size', vectors.length);
    const timer = metrics.startTimer('vectorize.upsert');

    try {
      // Split into batches if needed
      if (vectors.length > this.config.maxBatchSize) {
        logger.debug(
          `Splitting ${vectors.length} vectors into batches of ${this.config.maxBatchSize}`,
        );

        const batches: VectorWithMetadata[][] = [];
        for (let i = 0; i < vectors.length; i += this.config.maxBatchSize) {
          batches.push(vectors.slice(i, i + this.config.maxBatchSize));
        }

        // Process batches
        for (const batch of batches) {
          await this.upsertBatch(batch);
        }

        return;
      }

      // Process single batch
      await this.upsertBatch(vectors);
    } catch (error) {
      metrics.increment('vectorize.upsert.errors');
      logger.error({ error }, 'Error upserting vectors');
      throw error;
    } finally {
      timer.stop();
    }
  }

  /**
   * Store a batch of vectors in the Vectorize index
   * @param vectors Array of vectors with metadata
   * @private
   */
  private async upsertBatch(vectors: VectorWithMetadata[]): Promise<void> {
    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt < this.config.retryAttempts) {
      try {
        // Transform vectors to match VectorizeVector[]
        const vectorizeVectors = vectors.map(v => ({
          id: v.id,
          values: v.values,
          metadata: v.metadata as unknown as Record<string, VectorizeVectorMetadata>,
        }));

        await this.vectorize.upsert(vectorizeVectors);
        metrics.increment('vectorize.upsert.success');
        return;
      } catch (error) {
        attempt++;
        lastError = error instanceof Error ? error : new Error(String(error));

        // Log the error
        logger.warn(
          { error: lastError, attempt, maxAttempts: this.config.retryAttempts },
          `Vectorize upsert attempt ${attempt} failed, ${
            this.config.retryAttempts - attempt
          } retries left`,
        );

        // If we have retries left, wait before trying again
        if (attempt < this.config.retryAttempts) {
          await new Promise(resolve => setTimeout(resolve, this.config.retryDelay));
        }
      }
    }

    // If we've exhausted all retries, throw the last error
    metrics.increment('vectorize.upsert.failures');
    throw lastError || new Error('Failed to upsert vectors after multiple attempts');
  }

  /**
   * Query the Vectorize index for similar vectors
   * @param queryVector Vector embedding for the query
   * @param filter Optional metadata filter
   * @param topK Number of results to return
   * @returns Array of search results
   */
  public async query(
    queryVector: number[],
    filter: Partial<NoteVectorMeta> = {},
    topK = 10,
  ): Promise<VectorSearchResult[]> {
    if (!queryVector || queryVector.length === 0) {
      logger.warn('Empty query vector provided for vector search');
      return [];
    }

    // Track metrics
    metrics.increment('vectorize.query.requests');
    const timer = metrics.startTimer('vectorize.query');

    try {
      // Query the vector index
      const results = await this.vectorize.query(queryVector, { topK, filter });
      metrics.increment('vectorize.query.success');
      metrics.gauge('vectorize.query.results', results.matches.length);

      // Transform the results to match VectorSearchResult[]
      return results.matches.map(match => ({
        id: match.id,
        score: match.score,
        metadata: match.metadata as unknown as NoteVectorMeta,
      }));
    } catch (error) {
      metrics.increment('vectorize.query.errors');
      logger.error({ error, filter, topK }, 'Error querying vectors');
      throw error;
    } finally {
      timer.stop();
    }
  }

  /**
   * Get statistics about the Vectorize index
   * @returns Index statistics
   */
  public async getStats(): Promise<VectorIndexStats> {
    try {
      const info = await this.vectorize.describe();

      // Determine the dimension based on the config type
      let dimension = 0;
      if ('dimensions' in info.config) {
        dimension = info.config.dimensions;
      } else if ('preset' in info.config) {
        // For preset configs, we need to use a default or fetch from elsewhere
        // For now, use a default value
        dimension = 384; // Common embedding dimension
      }

      return {
        vectors: info.vectorsCount,
        dimension,
      };
    } catch (error) {
      logger.error({ error }, 'Error getting vector index stats');
      throw error;
    }
  }
}

/**
 * Create a default vectorize service instance
 */
export const createVectorizeService = (
  vectorize: VectorizeIndex,
  config?: Partial<VectorizeConfig>,
): VectorizeService => {
  return new VectorizeService(vectorize, config);
};
