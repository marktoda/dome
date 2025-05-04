import { getLogger, logError } from '@dome/common';
import { ObservabilityService } from '../services/observabilityService';
import { AgentState, Document, ToolResult } from '../types';
import { toDomeError } from '../utils/errors';
import { countTokens } from '../utils/tokenCounter';

/* ────────────────────────────────────────────────────────────────
 * combineContext
 *   1. take top doc per retrieval
 *   3. back-fill best remaining docs until token cap
 * ──────────────────────────────────────────────────────────────── */
export async function combineContext(
  state: AgentState,
  env: Env,
): Promise<Partial<AgentState>> {
  const log = getLogger().child({ node: 'combineContext' });
  const t0 = performance.now();
  const trace = state.metadata?.traceId ?? '';
  const span = ObservabilityService.startSpan(env, trace, 'combineContext', state);
  const cap = state.options.maxTokens;
  log.info({ cap, retrievals: state.retrievals?.length }, '[CombineContext]: Combining context up to token cap');

  try {
    /* 1 · helpers */
    const chunkToDoc = (c: any): Document => ({
      id: c.id,
      title: c.metadata.title ?? 'Untitled',
      body: c.content,
      metadata: {
        source: c.metadata.source,
        createdAt: c.metadata.createdAt ?? new Date().toISOString(),
        relevanceScore: c.metadata.rerankerScore ?? 0,
        mimeType: 'text/plain',
      },
    });

    /* 2 · collect top-per-retrieval & remainder */
    const topDocs: Document[] = [];
    const remainder: Document[] = [];

    for (const ret of state.retrievals ?? []) {
      if (!ret.chunks?.length) continue;

      const sorted = [...ret.chunks].sort(
        (a, b) => (b.metadata.rerankerScore ?? 0) - (a.metadata.rerankerScore ?? 0),
      );

      topDocs.push(chunkToDoc(sorted[0]));
      remainder.push(...sorted.slice(1).map(chunkToDoc));
    }

    /* 4 · fill until token cap */
    remainder.sort(
      (a, b) => (b.metadata.relevanceScore ?? 0) - (a.metadata.relevanceScore ?? 0),
    );

    const docs: Document[] = [];
    let tokens = 0;
    const tryAdd = (d: Document) => {
      const need = countTokens(d.body);
      if (tokens + need > cap) return false;
      tokens += need;
      docs.push(d);
      return true;
    };

    [...topDocs].forEach(tryAdd);  // must-include
    remainder.some(d => !tryAdd(d));            // stop when full
    log.info({ docCount: docs.length }, '[CombineContext] finished combining context');

    /* 5 · done */
    const elapsed = performance.now() - t0;
    ObservabilityService.endSpan(env, trace, span, 'combineContext', state, state, elapsed);

    return {
      docs,
      metadata: {
        currentNode: 'combineContext',
        executionTimeMs: elapsed,
      },
    };
  } catch (err) {
    /* error path */
    const e = toDomeError(err);
    logError(e, 'combineContext failed');
    const elapsed = performance.now() - t0;
    ObservabilityService.endSpan(env, trace, span, 'combineContext', state, state, elapsed);

    return {
      metadata: {
        currentNode: 'combineContext',
        errors: [
          ...(state.metadata?.errors ?? []),
          { node: 'combineContext', message: e.message, timestamp: Date.now() },
        ],
      },
      reasoning: ['Context aggregation failed; proceeding with fallback logic.'],
    };
  }
}
