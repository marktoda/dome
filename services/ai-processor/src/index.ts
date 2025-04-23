import { WorkerEntrypoint } from 'cloudflare:workers';
import { withLogger, logError, getLogger, metrics } from '@dome/logging';
import { createLlmService } from './services/llmService';
import { EnrichedContentMessage, NewContentMessage } from '@dome/common';
import { SiloClient, SiloBinding } from '@dome/silo/client';

const buildServices = (env: Env) => ({
  llm: createLlmService(env),
  silo: new SiloClient(env.SILO as unknown as SiloBinding),
});

const runWithLog = <T>(meta: Record<string, unknown>, fn: () => Promise<T>): Promise<T> =>
  withLogger(meta, async () => {
    try {
      return await fn();
    } catch (err) {
      logError(getLogger(), err, 'Unhandled error');
      throw err;
    }
  });

/**
 * AI Processor Worker
 *
 * This worker processes content from the NEW_CONTENT queue,
 * extracts metadata using LLM, and publishes results to the
 * ENRICHED_CONTENT queue.
 */
export default class AiProcessor extends WorkerEntrypoint<Env> {
  /** Lazily created bundle of service clients (re‑used for every call) */
  private _services?: ReturnType<typeof buildServices>;
  private get services() {
    return (this._services ??= buildServices(this.env));
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

      await this.env.ENRICHED_CONTENT.send(enrichedMessage);

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
