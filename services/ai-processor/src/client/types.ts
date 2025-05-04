import { z } from 'zod';
import { ReprocessRequestSchema, ReprocessResponseSchema } from '../types';

/**
 * AiProcessorBinding interface
 * Defines the contract for the Cloudflare Worker binding to the AI processor service
 */
export interface AiProcessorBinding {
  /**
   * Reprocess content
   * @param data Request data with optional ID
   * @returns Result of reprocessing
   */
  reprocess(
    data: z.infer<typeof ReprocessRequestSchema>,
  ): Promise<z.infer<typeof ReprocessResponseSchema>>;
}
