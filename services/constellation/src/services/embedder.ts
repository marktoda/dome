/**
 * Embedding Service
 *
 * Interfaces with Workers AI to generate embeddings.
 */

import { getLogger } from '@dome/logging';
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
      getLogger().warn('Empty texts array provided for embedding');
      return [];
    }

    // Track metrics
    metrics.increment('embedding.requests');
    metrics.gauge('embedding.batch_size', texts.length);
    const timer = metrics.startTimer('embedding');

    getLogger().debug(
      {
        textCount: texts.length,
        textSamples: texts.map(t => t.substring(0, 50) + (t.length > 50 ? '...' : '')).slice(0, 2),
        textLengths: texts.map(t => t.length),
        model: this.config.model,
      },
      'Generating embeddings for texts',
    );

    try {
      // Split into batches if needed
      if (texts.length > this.config.maxBatchSize) {
        getLogger().debug(
          `Splitting ${texts.length} texts into batches of ${this.config.maxBatchSize}`,
        );

        const batches: string[][] = [];
        for (let i = 0; i < texts.length; i += this.config.maxBatchSize) {
          batches.push(texts.slice(i, i + this.config.maxBatchSize));
        }

        // Process batches and combine results
        const results: number[][] = [];
        for (const batch of batches) {
          getLogger().debug({ batchSize: batch.length }, 'Processing embedding batch');
          const batchResults = await this.embedBatch(batch);
          results.push(...batchResults);
        }

        getLogger().debug(
          {
            totalEmbeddings: results.length,
            embeddingDimension: results[0]?.length,
          },
          'Combined embedding results from batches',
        );

        return results;
      }

      // Process single batch
      const results = await this.embedBatch(texts);
      getLogger().debug(
        {
          embeddingsCount: results.length,
          embeddingDimension: results[0]?.length,
        },
        'Generated embeddings for single batch',
      );

      return results;
    } catch (error) {
      metrics.increment('embedding.errors');
      getLogger().error({ error }, 'Error generating embeddings');
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

    getLogger().debug(
      {
        batchSize: texts.length,
        textLengthRange:
          texts.length > 0
            ? `${Math.min(...texts.map(t => t.length))} - ${Math.max(...texts.map(t => t.length))}`
            : 'N/A',
        model: this.config.model,
        retryAttempts: this.config.retryAttempts,
      },
      'Starting embedding batch operation',
    );

    while (attempt < this.config.retryAttempts) {
      try {
        getLogger().debug({ attempt: attempt + 1 }, 'Sending batch to AI service for embedding');

        // Cast the model name to any to avoid type errors
        // In a real implementation, you would use a valid model name from the AiModels type
        const response = await this.ai.run(this.config.model as any, { text: texts });
        metrics.increment('embedding.success');

        // Handle different response formats
        if (typeof response === 'object' && response !== null && 'data' in response) {
          const embeddings = (response as any).data;
          getLogger().debug(
            {
              responseType: 'data array',
              embeddingsCount: embeddings.length,
              embeddingDimension: embeddings[0]?.length,
            },
            'Successfully received embeddings from AI service',
          );
          return embeddings;
        } else {
          // If the response doesn't have a data property, return an empty array
          getLogger().warn(
            {
              responseType: typeof response,
              responseKeys:
                typeof response === 'object' && response !== null ? Object.keys(response) : [],
            },
            'Unexpected response format from AI service',
          );
          return [];
        }
      } catch (error) {
        attempt++;
        lastError = error instanceof Error ? error : new Error(String(error));

        // Log the error
        getLogger().warn(
          { error: lastError, attempt, maxAttempts: this.config.retryAttempts },
          `Embedding attempt ${attempt} failed, ${
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
