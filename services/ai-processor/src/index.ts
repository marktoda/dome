import { WorkerEntrypoint } from 'cloudflare:workers';
import { withLogger, logError, getLogger, metrics } from '@dome/logging';
import { createLlmService } from './services/llmService';
import { EnrichedContentMessage, NewContentMessage, SiloContentMetadata } from '@dome/common';
import { SiloClient, SiloBinding } from '@dome/silo/client';
import { z } from 'zod';

const buildServices = (env: Env) => ({
  llm: createLlmService(env),
  silo: new SiloClient(env.SILO as unknown as SiloBinding),
});

const runWithLog = <T>(meta: Record<string, unknown>, fn: () => Promise<T>): Promise<T> =>
  withLogger(meta, async () => {
    try {
      return await fn();
    } catch (err) {
      logError(err, 'Unhandled error');
      throw err;
    }
  });

// Define the schema for reprocess requests
export const ReprocessRequestSchema = z.object({
  id: z.string().optional(),
});

// Define the schema for reprocess responses
export const ReprocessResponseSchema = z.object({
  success: z.boolean(),
  reprocessed: z.union([
    z.object({
      id: z.string(),
      success: z.boolean(),
    }),
    z.object({
      total: z.number(),
      successful: z.number(),
    }),
  ]),
});

/**
 * AI Processor Worker
 *
 * This worker processes content from the NEW_CONTENT queue,
 * extracts metadata using LLM, and publishes results to the
 * ENRICHED_CONTENT queue.
 *
 * It also provides RPC functions for reprocessing content.
 */
export default class AiProcessor extends WorkerEntrypoint<Env> {
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
    return withLogger({ service: 'ai-processor', op: 'reprocess', id: data.id }, async () => {
      try {
        // Validate input
        const validatedData = ReprocessRequestSchema.parse(data);
        const { id } = validatedData;

        if (id) {
          // Reprocess specific content by ID
          getLogger().info({ id }, 'Reprocessing specific content by ID');
          const result = await this.reprocessById(id);
          return { success: true, reprocessed: result };
        } else {
          // Reprocess all content with null or "Content processing failed" summary
          getLogger().info('Reprocessing all content with null or failed summary');
          const result = await this.reprocessFailedContent();
          return { success: true, reprocessed: result };
        }
      } catch (error) {
        logError(error, 'Error in reprocess');
        metrics.increment('ai_processor.reprocess.errors', 1);
        throw error;
      }
    });
  }

  /**
   * Reprocess content by ID
   * @param id Content ID to reprocess
   * @returns Result of reprocessing
   */
  private async reprocessById(id: string): Promise<{ id: string; success: boolean }> {
    try {
      // Get content metadata from Silo
      const metadata = await this.services.silo.getMetadataById(id);

      if (!metadata) {
        throw new Error(`Content with ID ${id} not found`);
      }

      // Create a new content message and process it
      const message: NewContentMessage = {
        id: metadata.id,
        userId: metadata.userId,
        category: metadata.category,
        mimeType: metadata.mimeType,
      };

      await this.processMessage(message);

      metrics.increment('ai_processor.reprocess.success', 1, { type: 'by_id' });
      return { id, success: true };
    } catch (error) {
      logError(error, 'Error reprocessing content by ID', { id });
      metrics.increment('ai_processor.reprocess.errors', 1, { type: 'by_id' });
      return { id, success: false };
    }
  }

  /**
   * Reprocess all content with null or "Content processing failed" summary
   * @returns Result of reprocessing
   */
  private async reprocessFailedContent(): Promise<{ total: number; successful: number }> {
    try {
      // Get all content with null or "Content processing failed" summary
      const failedContent = await this.services.silo.findContentWithFailedSummary();

      getLogger().info({ count: failedContent.length }, 'Found content with failed summaries');

      let successful = 0;

      // Process each failed content
      for (const content of failedContent) {
        try {
          const message: NewContentMessage = {
            id: content.id,
            userId: content.userId,
            category: content.category,
            mimeType: content.mimeType,
          };

          await this.processMessage(message);
          successful++;
        } catch (error) {
          logError(error, 'Error reprocessing failed content', { id: content.id });
        }
      }

      metrics.increment('ai_processor.reprocess.success', 1, { type: 'all_failed' });
      metrics.increment('ai_processor.reprocess.total_processed', failedContent.length);
      metrics.increment('ai_processor.reprocess.successful', successful);

      return { total: failedContent.length, successful };
    } catch (error) {
      logError(error, 'Error reprocessing failed content');
      metrics.increment('ai_processor.reprocess.errors', 1, { type: 'all_failed' });
      return { total: 0, successful: 0 };
    }
  }

  /**
   * Queue handler for processing messages
   * @param batch Batch of messages from the queue
   * @param env Environment bindings
   */
  async queue(batch: MessageBatch<NewContentMessage>) {
    await runWithLog(
      { service: 'ai-processor', op: 'queue', size: batch.messages.length, ...this.env },
      async () => {
        const startTime = Date.now();
        const queueName = batch.queue;

        getLogger().info(
          {
            queueName,
            messageCount: batch.messages.length,
            firstMessageId: batch.messages[0]?.id,
          },
          'Processing queue batch',
        );

        // Track metrics
        metrics.increment('ai_processor.batch.received', 1);
        metrics.increment('ai_processor.messages.received', batch.messages.length);

        // Process each message in the batch
        for (const message of batch.messages) {
          try {
            await this.processMessage(message.body);
          } catch (error) {
            getLogger().error(
              {
                error: error instanceof Error ? error.message : String(error),
                messageId: message.id,
                contentId: message.body.id,
              },
              'Failed to process message',
            );
            metrics.increment('ai_processor.messages.errors', 1);
          }
        }

        // Log batch completion
        const duration = Date.now() - startTime;
        getLogger().info(
          {
            queueName,
            messageCount: batch.messages.length,
            durationMs: duration,
          },
          'Completed processing queue batch',
        );

        // Track batch processing time
        metrics.timing('ai_processor.batch.duration_ms', duration);
      },
    );
  }

  /**
   * Process a single message from the queue
   * @param message Message from the queue
   * @param env Environment bindings
   * @param llmService LLM service for processing content
   * @param siloService Silo service for fetching content
   */
  async processMessage(message: NewContentMessage) {
    const { id, userId, category, mimeType, deleted } = message;

    // Use category as contentType, fallback to mimeType or 'note'
    const contentType = category || mimeType || 'note';

    // Skip deleted content
    if (deleted) {
      getLogger().info({ id, userId }, 'Skipping deleted content');
      return;
    }

    // Skip non-text content types
    if (!isProcessableContentType(contentType)) {
      getLogger().info(
        { id, userId, contentType, category, mimeType },
        'Skipping non-processable content type',
      );
      return;
    }

    try {
      getLogger().info({ id, userId, contentType }, 'Processing content');

      // Fetch content from Silo
      const { body } = await this.services.silo.get(id, userId);

      // Skip empty content
      if (!body || body.trim().length === 0) {
        getLogger().info({ id, userId }, 'Skipping empty content');
        return;
      }

      // Process with LLM
      const metadata = await this.services.llm.processContent(body, contentType);

      // Publish to ENRICHED_CONTENT queue
      const enrichedMessage: EnrichedContentMessage = {
        id,
        userId,
        category: category as any, // Using category from the message
        mimeType: mimeType as any, // Using mimeType from the message
        metadata,
        timestamp: Date.now(),
      };

      // Only send to ENRICHED_CONTENT queue if it exists (it won't exist in dome-api)
      if ('ENRICHED_CONTENT' in this.env) {
        await (this.env as any).ENRICHED_CONTENT.send(enrichedMessage);
      }

      getLogger().info(
        {
          id,
          enrichedMessage,
          hasSummary: !!metadata.summary,
          hasTodos: Array.isArray(metadata.todos) && metadata.todos.length > 0,
        },
        'Successfully processed and published enriched content',
      );

      // Track successful processing
      metrics.increment('ai_processor.messages.processed', 1);
    } catch (error) {
      getLogger().error(
        {
          error: error instanceof Error ? error.message : String(error),
          id,
          userId,
          category,
          mimeType,
        },
        'Error processing content',
      );

      // Re-throw to allow queue retry mechanism to work
      throw error;
    }
  }
}

/**
 * Check if a content type is processable by the LLM
 * @param contentType Content type to check
 * @returns True if the content type is processable
 */
function isProcessableContentType(contentType: string): boolean {
  const processableTypes = ['note', 'code', 'article', 'text/plain', 'text/markdown'];
  return processableTypes.includes(contentType);
}
