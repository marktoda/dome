/**
 * Constellation Client
 *
 * This file exports a type-safe client for interacting with the Constellation service.
 * It provides methods for all Constellation operations and handles error logging, metrics, and validation.
 */

import { SiloContentItem, VectorMeta, VectorSearchResult, VectorIndexStats } from '@dome/common';
import { getLogger, logError, metrics } from '@dome/common';

const logger = getLogger();

/**
 * ConstellationBinding interface
 * Defines the contract for the Cloudflare Worker binding to the Constellation service
 */
export interface ConstellationBinding {
  embed(job: SiloContentItem): Promise<void>;
  query(text: string, filter?: Partial<VectorMeta>, topK?: number): Promise<VectorSearchResult[]>;
  stats(): Promise<VectorIndexStats>;
}

const MAX_TEXT_LENGTH = 8192;
const MIN_TEXT_LENGTH = 3;
const DEFAULT_TOP_K = 10;

/**
 * Implementation of the ConstellationClient interface
 * Provides methods for interacting with the Constellation service
 */
export class ConstellationClient {
  /**
   * Create a new ConstellationClient
   * @param binding The Cloudflare Worker binding to the Constellation service
   * @param metricsPrefix Optional prefix for metrics (defaults to 'constellation.client')
   */
  constructor(
    private readonly binding: ConstellationBinding,
    private readonly metricsPrefix: string = 'constellation.client',
  ) {}

  /**
   * Embed a single content item immediately (synchronous, use sparingly)
   * @param job The job to embed
   * @returns Promise resolving to void
   */
  async embed(job: SiloContentItem): Promise<void> {
    const startTime = performance.now();
    try {
      logger.info(
        {
          contentId: job.id,
          userId: job.userId,
          category: job.category,
          mimeType: job.mimeType,
          textLength: job.body?.length,
        },
        'Embedding content in Constellation',
      );

      await this.binding.embed(job);

      metrics.increment(`${this.metricsPrefix}.embed.success`);
      metrics.timing(`${this.metricsPrefix}.embed.latency_ms`, performance.now() - startTime);
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.embed.errors`);
      logError(error, 'Error embedding content in Constellation', {
        contentId: job.id,
        userId: job.userId,
      });
      throw error;
    }
  }

  /**
   * Perform a vector similarity search
   * @param text The text to search for
   * @param filter Optional metadata filter
   * @param topK Optional number of results to return
   * @returns Promise resolving to search results
   */
  async query(
    text: string,
    filter?: Partial<VectorMeta>,
    topK: number = DEFAULT_TOP_K,
  ): Promise<VectorSearchResult[]> {
    const startTime = performance.now();
    try {
      const processedText = this.preprocess(text);
      logger.info(
        {
          original: text,
          processed: processedText,
          textLength: text.length,
          filter,
          topK,
        },
        'Querying embeddings in constellation',
      );

      const results = await this.binding.query(text, filter, topK);

      logger.info(
        {
          resultCount: results.length,
          firstResult: results.length > 0 ? results[0] : null,
        },
        'Query results from Constellation',
      );

      metrics.increment(`${this.metricsPrefix}.query.success`);
      metrics.timing(`${this.metricsPrefix}.query.latency_ms`, performance.now() - startTime);
      metrics.gauge(`${this.metricsPrefix}.query.results`, results.length);

      return results;
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.query.errors`);
      logError(error, 'Error querying vectors in Constellation', {
        textLength: text.length,
        filter,
        topK,
      });
      throw error;
    }
  }

  /**
   * Get statistics about the vector index
   * @returns Promise resolving to vector index statistics
   */
  async stats(): Promise<VectorIndexStats> {
    const startTime = performance.now();
    try {
      logger.info('Fetching Constellation vector index statistics');

      const result = await this.binding.stats();

      metrics.increment(`${this.metricsPrefix}.stats.success`);
      metrics.timing(`${this.metricsPrefix}.stats.latency_ms`, performance.now() - startTime);

      return result;
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.stats.errors`);
      logError(error, 'Error fetching Constellation vector index statistics');
      throw error;
    }
  }

  /**
   * Preprocesses text for embedding generation
   *
   * @param text - The raw text to preprocess
   * @returns Processed text ready for embedding
   */
  private preprocess(text: string): string {
    // Normalize whitespace
    let processed = text.trim().replace(/\s+/g, ' ');

    // Handle very short inputs
    if (processed.length < MIN_TEXT_LENGTH) {
      processed = `${processed} ${processed} query search`;
    }

    // Truncate if too long
    if (processed.length > MAX_TEXT_LENGTH) {
      processed = processed.slice(0, MAX_TEXT_LENGTH);
    }

    return processed;
  }
}

/**
 * Create a new ConstellationClient
 * @param binding The Cloudflare Worker binding to the Constellation service
 * @param metricsPrefix Optional prefix for metrics (defaults to 'constellation.client')
 * @returns A new ConstellationClient instance
 */
export function createConstellationClient(
  binding: ConstellationBinding,
  metricsPrefix?: string,
): ConstellationClient {
  return new ConstellationClient(binding, metricsPrefix);
}
