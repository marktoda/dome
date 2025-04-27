import { getLogger } from '@dome/logging';
import { AgentState } from '../types';
import { countTokens } from '../utils/tokenCounter';
import { getUserId } from '../utils/stateUtils';
import { LlmService } from '../services/llmService';
import { ObservabilityService } from '../services/observabilityService';

/**
 * Node: split_rewrite
 * ------------------------------------------------------------------
 *  1. Identify the last user question.
 *  2. Decide whether it needs rewriting (multi‑question, ambiguous, or
 *     complex according to an LLM quick‑check).
 *  3. If so, call the LLM to rewrite it.
 *  4. Emit a **partial** state update (delta) — not the whole state —
 *     so downstream reducers can merge efficiently.
 */
export const splitRewrite = async (
  state: AgentState,
  env: Env,
): Promise<Partial<AgentState>> => {
  const logger = getLogger().child({ node: 'splitRewrite' });
  const t0 = performance.now();

  /* --------------------------------------------------------------- */
  /*  1. Grab the latest user message                               */
  /* --------------------------------------------------------------- */
  const lastUserMsg = [...state.messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) {
    logger.warn('No user message found');
    return { tasks: { originalQuery: '', rewrittenQuery: '' } };
  }

  const original = lastUserMsg.content;
  const originalTokens = countTokens(original);

  /* --------------------------------------------------------------- */
  /*  2. Observability IDs                                           */
  /* --------------------------------------------------------------- */
  const userId = getUserId(state);
  const traceId = state.metadata?.traceId ?? ObservabilityService.initTrace(env, userId, state);
  const spanId = ObservabilityService.startSpan(env, traceId, 'splitRewrite', state);
  const logEvt = (e: string, p: Record<string, unknown>) => ObservabilityService.logEvent(env, traceId, spanId, e, p);

  logEvt('query_processing_start', { original, originalTokens });

  /* --------------------------------------------------------------- */
  /*  3. Decide whether we need a rewrite                            */
  /* --------------------------------------------------------------- */
  const analysis = await LlmService.analyzeQueryComplexity(env, original, { traceId, spanId });
  const multiQuestion = original.split('?').length > 2;
  const ambiguous = /\b(it|this|that|they|these|those)\b/i.test(original);
  const needsRewrite = multiQuestion || ambiguous || analysis.isComplex;

  /* --------------------------------------------------------------- */
  /*  4. Rewrite if needed                                           */
  /* --------------------------------------------------------------- */
  let rewritten = original;
  if (needsRewrite) {
    const ctx = state.messages.slice(-6).filter(m => m.role !== 'system');
    rewritten = await LlmService.rewriteQuery(env, original, ctx);
    logEvt('query_rewrite_complete', { original, rewritten });
  }

  /* --------------------------------------------------------------- */
  /*  5. Finish up                                                   */
  /* --------------------------------------------------------------- */
  const elapsed = performance.now() - t0;
  logEvt('split_rewrite_complete', { original, rewritten, elapsedMs: elapsed });
  ObservabilityService.endSpan(env, traceId, spanId, 'splitRewrite', state, state, elapsed);

  logger.info({ original, rewritten, elapsedMs: elapsed }, 'splitRewrite done');

  /* --------------------------------------------------------------- */
  /*  6. Return only the delta                                       */
  /* --------------------------------------------------------------- */
  return {
    tasks: {
      ...state.tasks,
      originalQuery: original,
      rewrittenQuery: rewritten,
      queryAnalysis: analysis,
    },
    metadata: {
      ...state.metadata,
      traceId,
      spanId,
      currentNode: 'split_rewrite',
      nodeTimings: {
        ...state.metadata?.nodeTimings,
        splitRewrite: elapsed,
      },
      tokenCounts: {
        ...state.metadata?.tokenCounts,
        originalQuery: originalTokens,
        rewrittenQuery: countTokens(rewritten),
      },
    },
  };
};
