/**
 * Silo Service entrypoint
 *
 * This is the main entry point for the Silo service, implementing a WorkerEntrypoint
 * class that handles both RPC methods and queue processing.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { createLlmService } from './services/llmService';
import { NewContentMessage } from '@dome/common';
import { SiloClient, SiloBinding } from '@dome/silo/client';
import type { ServiceEnv } from './types';
import { z } from 'zod';
import {
  getLogger,
  logError,
  trackOperation,
  aiProcessorMetrics,
} from './utils/logging';
import { ReprocessResponseSchema, ReprocessRequestSchema } from './types';
import { ContentProcessor } from './utils/processor';
import * as rpcHandlers from './handlers/rpc';
import * as queueHandlers from './handlers/queues';

/**
 * Build service dependencies
 * @param env Environment bindings
 * @returns Service instances
 */
const buildServices = (env: ServiceEnv) => {
  const first = {
    llm: createLlmService(env),
    silo: new SiloClient(env.SILO),
  };

  return {
    ...first,
    processor: new ContentProcessor(env, first),
  };
};

/**
 * AI Processor Worker
 *
 * This worker processes content from the NEW_CONTENT queue,
 * extracts metadata using LLM, and publishes results to the
 * ENRICHED_CONTENT queue.
 *
 * It also provides RPC functions for reprocessing content.
 */
export default class AiProcessor extends WorkerEntrypoint<ServiceEnv> {
  /** Lazily created bundle of service clients (re‑used for every call) */
  private _services?: ReturnType<typeof buildServices>;
  private get services() {
    return (this._services ??= buildServices(this.env));
  }

  /**
   * RPC function to reprocess content
   * @param data Request data with optional ID
   * @returns Result of reprocessing
   */
  async reprocess(data: z.infer<typeof ReprocessRequestSchema>) {
    return rpcHandlers.reprocess.call(this, data);
  }

  /**
   * Reprocess content by ID
   * @param id Content ID to reprocess
   * @returns Result of reprocessing
   */
  /**
   * Reprocess content by ID
   * @param id Content ID to reprocess
   * @param requestId Request ID for correlation
   * @returns Result of reprocessing
   */
  private async reprocessById(id: string, requestId: string): Promise<{ id: string; success: boolean }> {
    return rpcHandlers.reprocessById.call(this, id, requestId);
  }

  /**
   * Reprocess all content with null or "Content processing failed" summary
   * @returns Result of reprocessing
   */
  /**
   * Reprocess all content with failed summaries
   * @param requestId Request ID for correlation
   * @returns Result statistics
   */
  private async reprocessFailedContent(requestId: string): Promise<{ total: number; successful: number }> {
    return rpcHandlers.reprocessFailedContent.call(this, requestId);
  }

  /**
   * Queue handler for processing regular content messages
   * @param batch Batch of messages from the queue
   */
  async queue(batch: MessageBatch<NewContentMessage>) {
    await queueHandlers.handleQueue.call(this, batch);
  }
}
