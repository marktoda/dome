/**
 * Embedding Service
 *
 * Interfaces with Workers AI to generate embeddings.
 */

import { logger } from '../utils/logging';
import { metrics } from '../utils/metrics';

/**
 * Configuration for the embedding service
 */
export interface EmbedderConfig {
  model: string;
  maxBatchSize: number;
  retryAttempts: number;
  retryDelay: number;
}

/**
 * Default configuration values
 */
export const DEFAULT_EMBEDDER_CONFIG: EmbedderConfig = {
  model: '@cf/baai/bge-small-en-v1.5',
  maxBatchSize: 20, // Workers AI limit
  retryAttempts: 3,
  retryDelay: 1000, // ms
};

/**
 * Embedding service for generating vector embeddings from text
 */
export class Embedder {
  private config: EmbedderConfig;
  private ai: Ai;

  constructor(ai: Ai, config: Partial<EmbedderConfig> = {}) {
    this.ai = ai;
    this.config = {
      ...DEFAULT_EMBEDDER_CONFIG,
      ...config,
    };
  }

  /**
   * Generate embeddings for a batch of text
   * @param texts Array of text strings to embed
   * @returns Array of embedding vectors
   */
  public async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) {
      logger.warn('Empty texts array provided for embedding');
      return [];
    }

    // Track metrics
    metrics.increment('embedding.requests');
    metrics.gauge('embedding.batch_size', texts.length);
    const timer = metrics.startTimer('embedding');

    try {
      // Split into batches if needed
      if (texts.length > this.config.maxBatchSize) {
        logger.debug(`Splitting ${texts.length} texts into batches of ${this.config.maxBatchSize}`);

        const batches: string[][] = [];
        for (let i = 0; i < texts.length; i += this.config.maxBatchSize) {
          batches.push(texts.slice(i, i + this.config.maxBatchSize));
        }

        // Process batches and combine results
        const results: number[][] = [];
        for (const batch of batches) {
          const batchResults = await this.embedBatch(batch);
          results.push(...batchResults);
        }

        return results;
      }

      // Process single batch
      return await this.embedBatch(texts);
    } catch (error) {
      metrics.increment('embedding.errors');
      logger.error({ error }, 'Error generating embeddings');
      throw error;
    } finally {
      timer.stop();
    }
  }

  /**
   * Generate embeddings for a single batch of text (respecting max batch size)
   * @param texts Array of text strings to embed
   * @returns Array of embedding vectors
   * @private
   */
  private async embedBatch(texts: string[]): Promise<number[][]> {
    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt < this.config.retryAttempts) {
      try {
        // Cast the model name to any to avoid type errors
        // In a real implementation, you would use a valid model name from the AiModels type
        const response = await this.ai.run(this.config.model as any, { text: texts });
        metrics.increment('embedding.success');
        
        // Handle different response formats
        if (typeof response === 'object' && response !== null && 'data' in response) {
          return (response as any).data;
        } else {
          // If the response doesn't have a data property, return an empty array
          logger.warn('Unexpected response format from AI service');
          return [];
        }
      } catch (error) {
        attempt++;
        lastError = error instanceof Error ? error : new Error(String(error));

        // Log the error
        logger.warn(
          { error: lastError, attempt, maxAttempts: this.config.retryAttempts },
          `Embedding attempt ${attempt} failed, ${this.config.retryAttempts - attempt} retries left`
        );

        // If we have retries left, wait before trying again
        if (attempt < this.config.retryAttempts) {
          await new Promise(resolve => setTimeout(resolve, this.config.retryDelay));
        }
      }
    }

    // If we've exhausted all retries, throw the last error
    metrics.increment('embedding.failures');
    throw lastError || new Error('Failed to generate embeddings after multiple attempts');
  }
}

/**
 * Create a default embedder instance
 */
export const createEmbedder = (ai: Ai, config?: Partial<EmbedderConfig>): Embedder => {
  return new Embedder(ai, config);
};
