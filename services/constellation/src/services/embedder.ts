/**
 * Embedding Service
 *
 * Interfaces with Workers AI to generate embeddings.
 */

import { metrics } from '../utils/metrics';
import { logger } from '../utils/logging';

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

    // Start metrics tracking
    const timer = this.startMetricsTracking(texts);

    try {
      // Log the embedding request details
      this.logEmbeddingRequest(texts);

      // Process texts based on batch size requirements
      return texts.length > this.config.maxBatchSize
        ? await this.processMultipleBatches(texts)
        : await this.processSingleBatch(texts);
    } catch (error) {
      this.handleEmbeddingError(error);
      throw error;
    } finally {
      timer.stop();
    }
  }

  /**
   * Start metrics tracking for embedding operation
   * @param texts Array of text strings to embed
   * @returns Timer object for tracking duration
   * @private
   */
  private startMetricsTracking(texts: string[]) {
    metrics.increment('embedding.requests');
    metrics.gauge('embedding.batch_size', texts.length);
    return metrics.startTimer('embedding');
  }

  /**
   * Log details about the embedding request
   * @param texts Array of text strings to embed
   * @private
   */
  private logEmbeddingRequest(texts: string[]) {
    logger.debug(
      {
        textCount: texts.length,
        textSamples: texts.map(t => t.substring(0, 50) + (t.length > 50 ? '...' : '')).slice(0, 2),
        textLengths: texts.map(t => t.length),
        model: this.config.model,
      },
      'Generating embeddings for texts',
    );
  }

  /**
   * Process multiple batches of texts for embedding
   * @param texts Array of text strings to embed
   * @returns Combined array of embedding vectors from all batches
   * @private
   */
  private async processMultipleBatches(texts: string[]): Promise<number[][]> {
    logger.debug(`Splitting ${texts.length} texts into batches of ${this.config.maxBatchSize}`);

    // Split texts into batches
    const batches = this.createBatches(texts);

    // Process each batch and combine results
    const results = await this.processBatches(batches);

    logger.debug(
      {
        totalEmbeddings: results.length,
        embeddingDimension: results[0]?.length,
      },
      'Combined embedding results from batches',
    );

    return results;
  }

  /**
   * Create batches from a large array of texts
   * @param texts Array of text strings to split into batches
   * @returns Array of text batches
   * @private
   */
  private createBatches(texts: string[]): string[][] {
    const batches: string[][] = [];
    for (let i = 0; i < texts.length; i += this.config.maxBatchSize) {
      batches.push(texts.slice(i, i + this.config.maxBatchSize));
    }
    return batches;
  }

  /**
   * Process multiple batches and combine their results
   * @param batches Array of text batches
   * @returns Combined array of embedding vectors
   * @private
   */
  private async processBatches(batches: string[][]): Promise<number[][]> {
    const results: number[][] = [];
    for (const batch of batches) {
      logger.debug({ batchSize: batch.length }, 'Processing embedding batch');
      const batchResults = await this.embedBatch(batch);
      results.push(...batchResults);
    }
    return results;
  }

  /**
   * Process a single batch of texts for embedding
   * @param texts Array of text strings to embed
   * @returns Array of embedding vectors
   * @private
   */
  private async processSingleBatch(texts: string[]): Promise<number[][]> {
    const results = await this.embedBatch(texts);
    logger.debug(
      {
        embeddingsCount: results.length,
        embeddingDimension: results[0]?.length,
      },
      'Generated embeddings for single batch',
    );
    return results;
  }

  /**
   * Handle embedding errors
   * @param error The error that occurred
   * @private
   */
  private handleEmbeddingError(error: unknown) {
    metrics.increment('embedding.errors');
    logger.error({ error }, 'Error generating embeddings');
  }

  /**
   * Generate embeddings for a single batch of text (respecting max batch size)
   * @param texts Array of text strings to embed
   * @returns Array of embedding vectors
   * @private
   */
  /**
   * Generate embeddings for a single batch of text (respecting max batch size)
   * @param texts Array of text strings to embed
   * @returns Array of embedding vectors
   * @private
   */
  private async embedBatch(texts: string[]): Promise<number[][]> {
    let attempt = 0;
    let lastError: Error | null = null;

    this.logBatchOperationStart(texts);

    while (attempt < this.config.retryAttempts) {
      try {
        logger.debug({ attempt: attempt + 1 }, 'Sending batch to AI service for embedding');

        // Send the batch to the AI service
        const response = await this.callAiService(texts);
        metrics.increment('embedding.success');

        // Process the response
        return this.processAiResponse(response);
      } catch (error) {
        // Handle retry logic
        const shouldRetry = this.handleRetryLogic(error, ++attempt);
        lastError = error instanceof Error ? error : new Error(String(error));

        if (shouldRetry) {
          await this.delay();
        } else {
          break;
        }
      }
    }

    // If we've exhausted all retries, throw the last error
    metrics.increment('embedding.failures');
    throw lastError || new Error('Failed to generate embeddings after multiple attempts');
  }

  /**
   * Log information about the batch operation start
   * @param texts Array of text strings to embed
   * @private
   */
  private logBatchOperationStart(texts: string[]) {
    const textLengthRange =
      texts.length > 0
        ? `${Math.min(...texts.map(t => t.length))} - ${Math.max(...texts.map(t => t.length))}`
        : 'N/A';

    logger.debug(
      {
        batchSize: texts.length,
        textLengthRange,
        model: this.config.model,
        retryAttempts: this.config.retryAttempts,
      },
      'Starting embedding batch operation',
    );
  }

  /**
   * Call the AI service to generate embeddings
   * @param texts Array of text strings to embed
   * @returns Raw response from the AI service
   * @private
   */
  private async callAiService(texts: string[]): Promise<any> {
    // Note: Type casting is necessary due to the dynamic nature of AI model names
    // A more type-safe approach would be to define a union type of supported models
    return await this.ai.run(this.config.model as any, { text: texts });
  }

  /**
   * Process the AI service response
   * @param response Response from the AI service
   * @returns Array of embedding vectors
   * @private
   */
  private processAiResponse(response: any): number[][] {
    // Handle different response formats
    if (typeof response === 'object' && response !== null && 'data' in response) {
      const embeddings = response.data;
      this.logSuccessfulResponse(embeddings);
      return embeddings;
    } else {
      this.logUnexpectedResponseFormat(response);
      return [];
    }
  }

  /**
   * Log information about a successful response
   * @param embeddings Array of embedding vectors
   * @private
   */
  private logSuccessfulResponse(embeddings: number[][]) {
    logger.debug(
      {
        responseType: 'data array',
        embeddingsCount: embeddings.length,
        embeddingDimension: embeddings[0]?.length,
      },
      'Successfully received embeddings from AI service',
    );
  }

  /**
   * Log information about an unexpected response format
   * @param response Response from the AI service
   * @private
   */
  private logUnexpectedResponseFormat(response: any) {
    logger.warn(
      {
        responseType: typeof response,
        responseKeys:
          typeof response === 'object' && response !== null ? Object.keys(response) : [],
      },
      'Unexpected response format from AI service',
    );
  }

  /**
   * Handle retry logic for failed embedding attempts
   * @param error Error that occurred
   * @param attempt Current attempt number
   * @returns Whether to retry
   * @private
   */
  private handleRetryLogic(error: unknown, attempt: number): boolean {
    const errorObj = error instanceof Error ? error : new Error(String(error));

    logger.warn(
      { error: errorObj, attempt, maxAttempts: this.config.retryAttempts },
      `Embedding attempt ${attempt} failed, ${this.config.retryAttempts - attempt} retries left`,
    );

    return attempt < this.config.retryAttempts;
  }

  /**
   * Delay execution before retrying
   * @private
   */
  private async delay(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, this.config.retryDelay));
  }
}

/**
 * Create a default embedder instance
 */
export const createEmbedder = (ai: Ai, config?: Partial<EmbedderConfig>): Embedder => {
  return new Embedder(ai, config);
};
