import { z } from 'zod';
import { ReprocessRequestSchema, ReprocessResponseSchema } from '../src/types';

/**
 * Interface for the AI processor binding
 */
interface AiProcessorBinding {
  reprocess(
    data: z.infer<typeof ReprocessRequestSchema>,
  ): Promise<z.infer<typeof ReprocessResponseSchema>>;
}

/**
 * Simplified client for the AI processor service
 * Uses console.log instead of the logger for scripts
 */
export class AiProcessorClient {
  /**
   * Create a new AiProcessorClient
   * @param binding The Cloudflare Worker binding to the AI processor service
   */
  constructor(private readonly binding: AiProcessorBinding) {}

  /**
   * Reprocess content by ID or all content with failed summaries
   * @param options Options for reprocessing
   * @param options.id Optional ID of the content to reprocess
   * @param options.userId User ID for the request
   * @returns Result of reprocessing
   */
  async reprocess(options: {
    id?: string;
    userId: string;
  }): Promise<z.infer<typeof ReprocessResponseSchema>> {
    const startTime = performance.now();
    try {
      console.log('Reprocessing content with AI processor', {
        id: options.id,
        operation: 'reprocess',
      });

      // Validate input
      const validatedData = ReprocessRequestSchema.parse(options);

      // Call the AI processor service directly via RPC
      const result = await this.binding.reprocess(validatedData);

      // Log performance
      console.log(`Reprocess completed in ${performance.now() - startTime}ms`);

      return result;
    } catch (error) {
      console.error('Error reprocessing content with AI processor', error);
      throw error;
    }
  }
}
