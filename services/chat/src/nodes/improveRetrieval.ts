import { getLogger } from '@dome/common';
import { AgentStateV3 as AgentState } from '../types/stateSlices';
import { ObservabilityService } from '../services/observabilityService';
import type { SliceUpdate } from '../types/stateSlices';

export type ImproveRetrievalUpdate = SliceUpdate<'metadata' | 'reasoning'>;

/**
 * improve_retrieval
 * ------------------
 * Very lightweight first version that only increments an iteration counter and
 * records an explanatory note so that downstream nodes (retrieval_selector)
 * can try a fresh strategy.  In future this node can:
 *  • inject hints into the query
 *  • alter retrieval parameters (e.g. expand synonyms)
 *  • downgrade thresholds, etc.
 */
export const improveRetrieval = async (state: AgentState, env: Env): Promise<ImproveRetrievalUpdate> => {
  const log = getLogger().child({ node: 'improveRetrieval' });
  const t0 = performance.now();

  const iteration = (state.metadata?.iteration ?? 0) + 1;

  // Observability span
  const traceId = state.metadata?.traceId ?? crypto.randomUUID();
  const spanId = ObservabilityService.startSpan(env, traceId, 'improveRetrieval', state);

  const elapsed = performance.now() - t0;
  ObservabilityService.endSpan(env, traceId, spanId, 'improveRetrieval', state, state, elapsed);

  log.info({ iteration }, 'Bumping RAG loop iteration');

  return {
    reasoning: [
      ...(state.reasoning ?? []),
      `Retrieval deemed inadequate – entering iteration ${iteration}`,
    ],
    metadata: {
      ...state.metadata,
      nodeTimings: { ...state.metadata?.nodeTimings, improveRetrieval: elapsed },
      currentNode: 'improve_retrieval',
      iteration,
    },
  };
}; 