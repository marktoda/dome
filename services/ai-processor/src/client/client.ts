import { getLogger, logError, metrics } from '@dome/common';
import { z } from 'zod';
import { ReprocessRequestSchema, ReprocessResponseSchema } from '../types';
import { AiProcessorBinding } from './types';

/**
 * Client for the AI processor service
 * Provides methods for interacting with the AI processor service
 */
export class AiProcessorClient {
  /**
   * Create a new AiProcessorClient
   * @param binding The Cloudflare Worker binding to the AI processor service
   * @param metricsPrefix Optional prefix for metrics (defaults to 'ai_processor.client')
   */
  constructor(
    private readonly binding: AiProcessorBinding,
    private readonly metricsPrefix: string = 'ai_processor.client',
  ) { }

  /**
   * Reprocess content by ID or all content with failed summaries
   * @param options Options for reprocessing
   * @param options.id Optional ID of the content to reprocess
   * @returns Result of reprocessing
   */
  async reprocess(options: { id?: string } = {}): Promise<z.infer<typeof ReprocessResponseSchema>> {
    const startTime = performance.now();
    try {
      getLogger().info(
        {
          id: options.id,
          operation: 'reprocess',
        },
        'Reprocessing content with AI processor',
      );

      // Validate input
      const validatedData = ReprocessRequestSchema.parse(options);

      // Call the AI processor service directly via RPC
      const result = await this.binding.reprocess(validatedData);

      // Track metrics
      metrics.increment(`${this.metricsPrefix}.reprocess.success`);
      metrics.timing(`${this.metricsPrefix}.reprocess.latency_ms`, performance.now() - startTime);

      return result;
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.reprocess.errors`);
      logError(error, 'Error reprocessing content with AI processor');
      throw error;
    }
  }
}

/**
 * Create a new AiProcessorClient
 * @param binding The Cloudflare Worker binding to the AI processor service
 * @param metricsPrefix Optional prefix for metrics (defaults to 'ai_processor.client')
 * @returns A new AiProcessorClient instance
 */
export function createAiProcessorClient(
  binding: AiProcessorBinding,
  metricsPrefix?: string,
): AiProcessorClient {
  return new AiProcessorClient(binding, metricsPrefix);
}
