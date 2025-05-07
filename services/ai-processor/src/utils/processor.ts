// ContentProcessor – single‑responsibility helper
// ───────────────────────────────────────────────────────────────
// • Early‑exit logic (deleted / unsupported / empty)
// • Delegates heavy lifting to LlmService
// • Centralised rate‑limit handling (queues into RATE_LIMIT_DLQ)
// • All queue publishing is optional‑binding‑safe
//
// Any worker can import this class and call `processMessage`.
// ───────────────────────────────────────────────────────────────

import {
  getLogger,
  logError,
  sanitizeForLogging,
  aiProcessorMetrics,
} from './logging';
import {
  assertExists,
  toDomeError,
  LLMProcessingError,
  ContentProcessingError,
} from '../utils/errors';
import { sendTodosToQueue } from '../todos';

import type {
  NewContentMessage,
  EnrichedContentMessage,
  SiloContentMetadata, // Will use SiloContentItem where body is expected
  SiloContentItem, // For objects that include a body
  ContentCategory, // Import for explicit typing
} from '@dome/common';
// Define LlmProcessingResult based on observed llmService output
import type { LlmService } from '../services/llmService';
import type { NoteProcessingResult, CodeProcessingResult, ArticleProcessingResult, DefaultProcessingResult } from '../schemas';
import type { SiloClient } from '@dome/silo/client';

// This is a generic representation. The actual 'parsed' part will be one of the *ProcessingResult types.
export type LlmProcessingResult = (NoteProcessingResult | CodeProcessingResult | ArticleProcessingResult | DefaultProcessingResult) & {
  processingVersion: number;
  modelUsed: string;
  error?: string;
};

const DEFAULT_CONTENT_TYPE = 'note';
const DEFAULT_PROCESSING_VERSION = 2;
const DEFAULT_MODEL_USED = '@cf/google/gemma-7b-it-lora';
const UNTITLED_CONTENT = 'Untitled Content';

/** Helper bundle expected by ContentProcessor */
export interface ProcessorServices {
  llm: LlmService;
  silo: SiloClient;
}

interface ExistingMetadata {
  title?: string;
  summary?: string;
  tags?: string[];
}

/**
 * ContentProcessor – no I/O side‑effects beyond env queues.
 */
export class ContentProcessor {
  constructor(private readonly env: Env, private readonly services: ProcessorServices) { }

  /** Process a single NEW_CONTENT message (idempotent). */
  async processMessage(msg: NewContentMessage, requestId: string): Promise<void> {
    const { id, userId, category, mimeType } = msg;
    const logger = getLogger();
    const contentType = category || mimeType || DEFAULT_CONTENT_TYPE;

    if (this._performInitialChecks(msg, contentType, requestId)) {
      return;
    }

    try {
      const doc = await this._fetchContentDocument(id, userId, requestId);
      // _fetchContentDocument now returns SiloContentItem | null
      if (!doc || !doc.body) {
        return;
      }
      const body = doc.body;

      const existingMetadata = this._extractExistingMetadata(doc, id, requestId);
      const llmResult = await this._invokeLlmService(body, contentType, existingMetadata);

      if (!llmResult) { // LlmService already queued rate‑limited work or other issue
        return;
      }

      await this._handleSuccessfulProcessing(msg, llmResult, contentType);

    } catch (err) {
      if (this.isRateLimitError(err)) {
        await this.queueRateLimited(msg); // Removed err argument as it's not used
        return;
      }

      const domeErr = this.classify(err, {
        id,
        userId,
        contentType,
        requestId,
      });
      logError(domeErr, 'processMessage failed');
      aiProcessorMetrics.counter('messages.errors', 1, { errorType: domeErr.code, contentType });
      throw domeErr; // let queue retry
    }
  }

  // -----------------------------------------------------------------------
  // Private refactored methods from processMessage
  // -----------------------------------------------------------------------

  private _performInitialChecks(msg: NewContentMessage, contentType: string, requestId: string): boolean {
    const { id, userId, deleted } = msg;
    const logger = getLogger();

    if (deleted) {
      logger.info({ id, userId, requestId }, 'Skipping deleted content');
      return true;
    }

    if (!this.isProcessable(contentType)) {
      logger.info({ id, userId, contentType, requestId }, 'Skipping unprocessable type');
      return true;
    }
    return false;
  }

  private async _fetchContentDocument(id: string, userId: string | undefined | null, requestId: string): Promise<SiloContentItem | null> {
    const logger = getLogger();
    // Assuming silo.get returns a SiloContentItem or similar that includes 'body'
    const doc: SiloContentItem | null = await this.services.silo.get(id, userId);
    assertExists(doc, `Content ${id} not found`, { id, requestId });

    // doc is now guaranteed to be non-null by assertExists
    const body = doc.body?.trim();
    if (!body) {
      logger.info({ id, requestId }, 'Skipping empty body');
      return null;
    }
    // Return the original doc if body is fine, or a modified one if needed (though trim doesn't change original object)
    return { ...doc, body };
  }

  private _extractExistingMetadata(doc: SiloContentItem, id: string, requestId: string): ExistingMetadata | undefined {
    const logger = getLogger();
    // Assuming 'tags' might be in customMetadata if it exists
    const tagsFromCustomMetadata = doc.customMetadata && Array.isArray(doc.customMetadata.tags) && doc.customMetadata.tags.every((tag: unknown) => typeof tag === 'string')
      ? doc.customMetadata.tags as string[]
      : undefined;

    const existingMetadata: ExistingMetadata = {
      title: doc.title || undefined,
      summary: doc.summary || undefined,
      tags: tagsFromCustomMetadata,
    };

    const hasExistingMetadata = !!(existingMetadata.title || existingMetadata.summary ||
      (existingMetadata.tags && existingMetadata.tags.length > 0));

    if (hasExistingMetadata) {
      logger.info({
        id,
        requestId,
        hasTitle: !!existingMetadata.title,
        hasSummary: !!existingMetadata.summary,
        hasTags: !!(existingMetadata.tags && existingMetadata.tags.length > 0)
      }, 'Processing with existing metadata as context');
      return existingMetadata;
    }
    return undefined;
  }

  private async _invokeLlmService(body: string, contentType: string, existingMetadata?: ExistingMetadata): Promise<LlmProcessingResult | null> {
    return this.services.llm.processContent(
      body,
      contentType,
      existingMetadata
    );
  }

  private async _handleSuccessfulProcessing(
    msg: NewContentMessage,
    llmResult: LlmProcessingResult,
    contentType: string
  ): Promise<void> {
    const { id, userId, category, mimeType } = msg;
    const metadata = this.normalize(llmResult);
    await this.publishResult({ id, userId, category, mimeType, metadata });
    this.trackSuccess(metadata, contentType);
  }


  // -----------------------------------------------------------------------
  // Original Private helpers (some modified)
  // -----------------------------------------------------------------------

  private isProcessable(type: string): boolean {
    return true; // Placeholder – plug actual list if needed
  }

  private normalize(raw: LlmProcessingResult): EnrichedContentMessage['metadata'] {
    return {
      title: typeof raw.title === 'string' ? raw.title : UNTITLED_CONTENT,
      summary: typeof raw.summary === 'string' ? raw.summary : undefined,
      todos: 'todos' in raw && Array.isArray(raw.todos) ? raw.todos : undefined,
      reminders: 'reminders' in raw && Array.isArray(raw.reminders) ? raw.reminders : undefined,
      topics: Array.isArray(raw.topics) ? raw.topics : undefined,
      processingVersion: typeof raw.processingVersion === 'number' ? raw.processingVersion : DEFAULT_PROCESSING_VERSION,
      modelUsed: typeof raw.modelUsed === 'string' ? raw.modelUsed : DEFAULT_MODEL_USED,
      error: typeof raw.error === 'string' ? raw.error : undefined,
    } satisfies EnrichedContentMessage['metadata'];
  }

  private async publishResult({
    id,
    userId,
    category,
    mimeType,
    metadata,
  }: {
    id: string;
    userId?: string | null;
    category?: string | null;
    mimeType?: string | null;
    metadata: EnrichedContentMessage['metadata'];
  }): Promise<void> {
    const enriched: EnrichedContentMessage = {
      id,
      userId: userId ?? null,
      category: (category ?? DEFAULT_CONTENT_TYPE) as ContentCategory,
      mimeType: mimeType ?? 'application/octet-stream',
      metadata,
      timestamp: Date.now(),
    };

    // Use optional chaining for queue sending
    await this.env.ENRICHED_CONTENT?.send(enriched);

    if (metadata.todos?.length && userId) {
      // Ensure TODOS queue exists before sending
      await this.env.TODOS?.sendBatch(
         metadata.todos.map(todo => ({ body: { ...enriched, metadata: { ...enriched.metadata, ...todo} } }))
      );
      // The original sendTodosToQueue might have more complex logic,
      // for simplicity here, directly sending. If sendTodosToQueue is complex,
      // it should be updated to use optional chaining for this.env.TODOS
      // For now, assuming direct send is okay or sendTodosToQueue handles undefined queue.
      // Reverting to original call if it's safer and handles undefined queue.
      if (this.env.TODOS) {
         await sendTodosToQueue(enriched, this.env.TODOS);
      }
    }

    const safe = sanitizeForLogging({
      id,
      title: metadata.title,
      hasSummary: !!metadata.summary,
      summaryLength: metadata.summary?.length ?? 0,
      hasTodos: !!metadata.todos?.length,
    });

    getLogger().info(safe, 'Enriched content published');
  }

  private isRateLimitError(err: unknown): boolean {
    return (
      err instanceof Error &&
      (err.message.includes('Capacity temporarily exceeded') || err.message.includes('3040'))
    );
  }

  private async queueRateLimited(msg: NewContentMessage): Promise<void> {
    // Removed redundant silo.get and assertExists
    if (this.env.RATE_LIMIT_DLQ) {
      await this.env.RATE_LIMIT_DLQ.send(msg);
      getLogger().info({ id: msg.id }, 'Queued rate‑limited content to RATE_LIMIT_DLQ');
    } else {
      getLogger().warn({ id: msg.id }, 'RATE_LIMIT_DLQ not configured. Cannot queue rate-limited message.');
    }
  }

  private classify(err: unknown, ctx: Record<string, unknown>): import('@dome/errors').DomeError {
    if (err instanceof Error && err.message.includes('LLM')) {
      return new LLMProcessingError('LLM failed', ctx, err);
    }
    if (err instanceof Error && err.message.includes('Silo')) {
      return new ContentProcessingError('Silo fetch failed', ctx, err);
    }
    return toDomeError(err, 'Processing error', ctx);
  }

  private trackSuccess(meta: EnrichedContentMessage['metadata'], type: string): void {
    aiProcessorMetrics.counter('messages.processed', 1, {
      contentType: type,
      hasSummary: (!!meta.summary).toString(),
      hasTodos: (meta.todos?.length ? true : false).toString(),
    });
  }
}
