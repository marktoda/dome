/**
 * Reranker – global, source-agnostic chunk scoring
 * ------------------------------------------------
 * Thin public wrapper that:
 * 1. Picks the concrete implementation (Cohere vs Workers-AI) via `createReranker`.
 * 2. Merges retrieval tasks into a single candidate set, applies the global reranker,
 *    and writes the normalised scores back into each task.
 * 3. Returns the updated `retrievals` slice while recording timing metadata.
 *
 * All heavy lifting lives in `./core` (shared helpers) and `./impl/*` (engines).
 */

import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { logError } from '@dome/common';
import { ObservabilityService } from '../../services/observabilityService';
import type { DocumentChunk, RetrievalResult, RetrievalTask } from '../../types';
import {
  BaseReranker,
  DEFAULTS,
  RerankerOptions,
  CohereOpts,
  WorkersAiOpts,
  filterAndLimit,
} from './core';
import { CohereReranker } from './impl/cohere';
import { WorkersAIReranker } from './impl/workersAi';
import { toDomeError } from '@dome/common/errors';
import { AgentStateV3 as AgentState } from '../../types/stateSlices';
import type { SliceUpdate } from '../../types/stateSlices';

/* ------------------------------------------------------------------ */
/*  Factory chooser                                                    */
/* ------------------------------------------------------------------ */

export function createReranker(opts: RerankerOptions, env: Env) {
  const cfg = { ...DEFAULTS, ...opts } as Required<RerankerOptions>;
  const runner: BaseReranker =
    cfg.implementation === 'workers-ai'
      ? new WorkersAIReranker(cfg as Required<WorkersAiOpts>)
      : new CohereReranker(cfg as Required<CohereOpts>, env);

  return (retrieval: RetrievalResult, query: string, env2: Env, traceId: string, spanId: string) =>
    runner.rerank(retrieval, query, env2, traceId, spanId);
}

/* ------------------------------------------------------------------ */
/*  Public LangGraph node                                             */
/* ------------------------------------------------------------------ */

export type RerankerUpdate = SliceUpdate<'retrievals'>;

export async function reranker(
  state: AgentState,
  _cfg: LangGraphRunnableConfig,
  env: Env,
): Promise<RerankerUpdate> {
  const t0 = performance.now();
  const nodeId = 'reranker';
  const traceId = state.metadata?.traceId ?? crypto.randomUUID();
  const spanId = ObservabilityService.startSpan(env, traceId, nodeId, state);

  try {
    const tasks = mergeTasks(state.retrievals as RetrievalTask[] | undefined);
    if (!tasks.length) return finish(state, nodeId, spanId, traceId, t0, env);

    // Collect all chunks globally
    const allChunks: DocumentChunk[] = [];
    const idToTask = new Map<string, RetrievalTask>();
    tasks.forEach(t => {
      t.chunks?.forEach(c => {
        allChunks.push(c);
        idToTask.set(c.id, t);
      });
    });

    if (!allChunks.length) return finish(state, nodeId, spanId, traceId, t0, env);

    // Pick a model implementation
    const query = [...(state.messages ?? [])].reverse().find(m => m.role === 'user')?.content ?? '';
    const modelOpts = pickGlobalModel(allChunks, query, env);
    const globalRerank = createReranker({ ...DEFAULTS, ...modelOpts, name: 'global' }, env);

    const res = await globalRerank(
      {
        query,
        chunks: allChunks,
        sourceType: 'mixed',
        metadata: {
          executionTimeMs: 0,
          retrievalStrategy: 'merged',
          totalCandidates: allChunks.length,
        },
      },
      query,
      env,
      traceId,
      spanId,
    );

    if (!res?.chunks) throw new Error('Reranker returned no chunks');

    // Write scores back into tasks
    const chunkMap = new Map(res.chunks.map(c => [c.id, c] as const));
    const updatedTasks = tasks.map(t => {
      const scored = (t.chunks ?? []).map(c => chunkMap.get(c.id) ?? c);
      return { ...t, chunks: filterAndLimit(scored, DEFAULTS) } as RetrievalTask;
    });

    return finish({ ...state, retrievals: updatedTasks }, nodeId, spanId, traceId, t0, env);
  } catch (e) {
    const err = toDomeError(e);
    logError(err, 'Reranker node failed');
    const elapsed = performance.now() - t0;
    ObservabilityService.endSpan(env, traceId, spanId, nodeId, state, state, elapsed);
    return {
      metadata: {
        ...state.metadata,
        errors: [
          ...(state.metadata?.errors ?? []),
          { node: nodeId, message: err.message, timestamp: Date.now() },
        ],
      },
    };
  }
}

/* ------------------------------------------------------------------ */
/*  Helper functions                                                   */
/* ------------------------------------------------------------------ */

function mergeTasks(tasks: RetrievalTask[] | undefined): RetrievalTask[] {
  if (!tasks) return [];
  const map = new Map<string, RetrievalTask>();
  tasks.forEach(t => {
    const key = `${t.category}:${t.query}`;
    map.set(key, { ...t, chunks: [...(map.get(key)?.chunks ?? []), ...(t.chunks ?? [])] });
  });
  return [...map.values()];
}

function pickGlobalModel(allChunks: DocumentChunk[], query: string, env: Env): RerankerOptions {
  const multilingual = /[^\x00-\x7F]/.test(query);
  const isCode =
    allChunks.some(c => c.metadata.sourceType === 'code') || query.toLowerCase().includes('code');
  if ((env as any).COHERE_API_KEY) {
    return { implementation: 'cohere', model: 'rerank-v3.5' } as CohereOpts;
  }
  return { implementation: 'workers-ai', model: '@cf/baai/bge-reranker-base' } as WorkersAiOpts;
}

function finish(
  newState: AgentState,
  nodeId: string,
  spanId: string,
  traceId: string,
  t0: number,
  env: Env,
): RerankerUpdate {
  const elapsed = performance.now() - t0;
  ObservabilityService.endSpan(env, traceId, spanId, nodeId, newState, newState, elapsed);
  return {
    retrievals: newState.retrievals,
    metadata: {
      ...newState.metadata,
      nodeTimings: { ...newState.metadata?.nodeTimings, [nodeId]: elapsed },
      currentNode: nodeId,
    },
  };
}
