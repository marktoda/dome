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
} from '@dome/common';
import type { LlmService } from '../services/llmService';
import type { SiloClient } from '@dome/silo/client';

/** Helper bundle expected by ContentProcessor */
export interface ProcessorServices {
  llm: LlmService;
  silo: SiloClient;
}

/**
 * ContentProcessor – no I/O side‑effects beyond env queues.
 */
export class ContentProcessor {
  constructor(private readonly env: Env, private readonly services: ProcessorServices) { }

  /** Process a single NEW_CONTENT message (idempotent). */
  async processMessage(msg: NewContentMessage, requestId: string): Promise<void> {
    const { id, userId, category, mimeType, deleted } = msg;
    const logger = getLogger();

    const contentType = category || mimeType || 'note';

    // ---------------------------------------------------------------------
    // Early‑exit paths
    // ---------------------------------------------------------------------
    if (deleted) {
      logger.info({ id, userId, requestId }, 'Skipping deleted content');
      return;
    }

    if (!this.isProcessable(contentType)) {
      logger.info({ id, userId, contentType, requestId }, 'Skipping unprocessable type');
      return;
    }

    // ---------------------------------------------------------------------
    // Fetch + LLM processing
    // ---------------------------------------------------------------------
    try {
      const doc = await this.services.silo.get(id, userId);
      assertExists(doc, `Content ${id} not found`, { id, requestId });

      const body = doc.body?.trim();
      if (!body) {
        logger.info({ id, requestId }, 'Skipping empty body');
        return;
      }

      const raw = await this.services.llm.processContent(body, contentType);
      if (!raw) return; // LlmService already queued rate‑limited work

      const metadata = this.normalize(raw);

      await this.publishResult({ id, userId, category, mimeType, metadata });
      this.trackSuccess(metadata, contentType);
    } catch (err) {
      if (this.isRateLimitError(err)) {
        await this.queueRateLimited(msg, err);
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
  // Private helpers
  // -----------------------------------------------------------------------

  private isProcessable(type: string) {
    return true; // Placeholder – plug actual list if needed
  }

  private normalize(raw: any) {
    return {
      title: typeof raw.title === 'string' ? raw.title : 'Untitled Content',
      summary: typeof raw.summary === 'string' ? raw.summary : undefined,
      todos: Array.isArray(raw.todos) ? raw.todos : undefined,
      reminders: Array.isArray(raw.reminders) ? raw.reminders : undefined,
      topics: Array.isArray(raw.topics) ? raw.topics : undefined,
      processingVersion: typeof raw.processingVersion === 'number' ? raw.processingVersion : 2,
      modelUsed: typeof raw.modelUsed === 'string' ? raw.modelUsed : '@cf/google/gemma-7b-it-lora',
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
  }) {
    const enriched: EnrichedContentMessage = {
      id,
      userId: userId ?? null,
      category: (category ?? undefined) as any,
      mimeType: (mimeType ?? undefined) as any,
      metadata,
      timestamp: Date.now(),
    };

    if ('ENRICHED_CONTENT' in this.env) {
      await (this.env as any).ENRICHED_CONTENT.send(enriched);
    }

    if ('TODOS' in this.env && metadata.todos?.length && userId) {
      await sendTodosToQueue(enriched, (this.env as any).TODOS);
    }

    const safe = sanitizeForLogging({
      id,
      hasSummary: !!metadata.summary,
      summaryLength: metadata.summary?.length ?? 0,
      hasTodos: !!metadata.todos?.length,
    });

    getLogger().info(safe, 'Enriched content published');
  }

  private isRateLimitError(err: unknown) {
    return (
      err instanceof Error &&
      (err.message.includes('Capacity temporarily exceeded') || err.message.includes('3040'))
    );
  }

  private async queueRateLimited(
    msg: NewContentMessage,
    err: unknown,
  ) {
    const doc = await this.services.silo.get(msg.id, msg.userId);
    assertExists(doc?.body, 'Missing body for DLQ');

    await this.env.RATE_LIMIT_DLQ.send(msg);

    getLogger().info({ id: msg.id }, 'Queued rate‑limited content');
  }

  private classify(err: unknown, ctx: Record<string, unknown>) {
    if (err instanceof Error && err.message.includes('LLM')) {
      return new LLMProcessingError('LLM failed', ctx, err);
    }
    if (err instanceof Error && err.message.includes('Silo')) {
      return new ContentProcessingError('Silo fetch failed', ctx, err);
    }
    return toDomeError(err, 'Processing error', ctx);
  }

  private trackSuccess(meta: EnrichedContentMessage['metadata'], type: string) {
    aiProcessorMetrics.counter('messages.processed', 1, {
      contentType: type,
      hasSummary: (!!meta.summary).toString(),
      hasTodos: (meta.todos?.length ? true : false).toString(),
    });
  }
}
