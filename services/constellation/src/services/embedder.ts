/**
 * Embedding Service
 *
 * Interfaces with Workers AI to generate embeddings.
 */

import { getLogger, logError, constellationMetrics as metrics } from '../utils/constellationLogging';

const logger = getLogger();
import { sliceIntoBatches } from '../utils/batching';
import { EmbeddingError } from '../utils/errors';
import { KnownAiModels, AiTextEmbeddingInput, AiTextEmbeddingOutput } from '../types';
import { retryAsync, RetryConfig } from '../utils/retry';

/**
 * Configuration for the embedding service
 */
export interface EmbedderConfig {
  model: KnownAiModels;
  maxBatchSize: number;
  retryAttempts: number;
  retryDelay: number;
}

/**
 * Default configuration values
 */
export const DEFAULT_EMBEDDER_CONFIG: EmbedderConfig = {
  model: '@cf/baai/bge-large-en-v1.5',
  maxBatchSize: 10, // Reduced from 20 to prevent memory issues
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
    metrics.counter('embedding.requests', 1);
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
    logger.debug(
      `Splitting ${texts.length} texts into batches of ${this.config.maxBatchSize}`,
    );

    // Split texts into batches
    const batches = sliceIntoBatches(texts, this.config.maxBatchSize);

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
   * Process multiple batches and combine their results
   * @param batches Array of text batches
   * @returns Combined array of embedding vectors
   * @private
   */
  private async processBatches(batches: string[][]): Promise<number[][]> {
    const results: number[][] = [];

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      logger.debug(
        {
          batchIndex: i + 1,
          totalBatches: batches.length,
          batchSize: batch.length,
        },
        'Processing embedding batch',
      );

      const batchResults = await this.embedBatch(batch);
      results.push(...batchResults);

      // Clear references to help garbage collection
      batches[i] = [];

      // Add a small delay between batches to allow for garbage collection
      if (i < batches.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
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
    metrics.counter('embedding.errors', 1);
    logError(error, 'Error generating embeddings', { operation: 'handleEmbeddingError' });
  }

  /**
   * Generate embeddings for a single batch of text (respecting max batch size)
   * @param texts Array of text strings to embed
   * @returns Array of embedding vectors
   * @private
   */
  private async embedBatch(texts: string[]): Promise<number[][]> {
    this.logBatchOperationStart(texts);

    const retryConfig: RetryConfig = {
      attempts: this.config.retryAttempts,
      delayMs: this.config.retryDelay,
      operationName: 'embedBatch-aiCall',
    };

    try {
      const response = await retryAsync(
        async currentAttempt => {
          logger.debug(
            { attempt: currentAttempt },
            'Sending batch to AI service for embedding',
          );
          // Send the batch to the AI service
          return this.callAiService(texts);
        },
        retryConfig,
        { model: this.config.model, batchSize: texts.length },
      );

      metrics.counter('embedding.success', 1);
      // Process the response
      return this.processAiResponse(response);
    } catch (error) {
      metrics.counter('embedding.failures', 1);
      // Ensure the error is an EmbeddingError before re-throwing or handling further
      if (error instanceof EmbeddingError) {
        throw error;
      } else if (error instanceof Error) {
        throw new EmbeddingError(
          `Failed to generate embeddings after ${this.config.retryAttempts} attempts: ${error.message}`,
          {
            model: this.config.model,
            batchSize: texts.length,
            retryAttempts: this.config.retryAttempts,
          },
          error,
        );
      } else {
        throw new EmbeddingError(
          `Failed to generate embeddings after ${this.config.retryAttempts} attempts: Unknown error`,
          {
            model: this.config.model,
            batchSize: texts.length,
            retryAttempts: this.config.retryAttempts,
          },
        );
      }
    }
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
  private async callAiService(texts: string[]): Promise<AiTextEmbeddingOutput> {
    const input: AiTextEmbeddingInput = { text: texts };
    const response = await this.ai.run(this.config.model, input);

    // Basic type guard for the response
    if (
      typeof response === 'object' &&
      response !== null &&
      'data' in response &&
      Array.isArray((response as AiTextEmbeddingOutput).data)
    ) {
      return response as AiTextEmbeddingOutput;
    }
    // Throw an error if the response format is not as expected
    throw new EmbeddingError('Unexpected AI service response format', {
      model: this.config.model,
      responseType: typeof response,
      responseKeys: typeof response === 'object' && response !== null ? Object.keys(response) : [],
    });
  }

  /**
   * Process the AI service response
   * @param response Response from the AI service
   * @returns Array of embedding vectors
   * @private
   */
  private processAiResponse(response: AiTextEmbeddingOutput): number[][] {
    // The callAiService method now ensures the response is in the expected format
    const embeddings = response.data;
    this.logSuccessfulResponse(embeddings);
    return embeddings;
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
  // Removed handleRetryLogic and delay methods as their functionality is now in retryAsync
}

/**
 * Create a default embedder instance
 */
export const createEmbedder = (ai: Ai, config?: Partial<EmbedderConfig>): Embedder => {
  return new Embedder(ai, config);
};
