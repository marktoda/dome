// Reranker utilities and node – global‑aware, easily extensible
// =============================================================================
// A single file that:
//   • provides drop‑in Cohere / Workers‑AI back‑ends
//   • **globally** reranks all chunks so scores are comparable across sources
//   • writes the globally‑normalised scores back into each task
// =============================================================================

/* -------------------------------------------------------------------------- */
/*  Shared imports & types                                                     */
/* -------------------------------------------------------------------------- */

import { getLogger } from '@dome/common';
import {
  DocumentChunk,
  RetrievalResult,
  RetrievalTask,
  RetrievalToolType,
  AgentState,
} from '../types';
import { ObservabilityService } from '../services/observabilityService';
import { toDomeError } from '../utils/errors';
import { CohereRerank } from '@langchain/cohere';
import { Document } from '@langchain/core/documents';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';

/* -------------------------------------------------------------------------- */
/*  Configuration                                                              */
/* -------------------------------------------------------------------------- */

type Impl = 'cohere' | 'workers-ai';

export type RerankerOptions = WorkersAiOpts | CohereOpts;

interface BaseOpts {
  name: string;
  scoreThreshold?: number;
  maxResults?: number; // per‑rerank call
  keepBelowThreshold?: boolean;
}

interface WorkersAiOpts extends BaseOpts {
  implementation: 'workers-ai';
  model: '@cf/baai/bge-reranker-base';
}

interface CohereOpts extends BaseOpts {
  implementation: 'cohere';
  model: 'rerank-v3.5';
  cohereApiKey?: string;
}

const DEFAULTS: RerankerOptions = {
  name: 'global',
  implementation: 'cohere',
  model: 'rerank-v3.5',
  scoreThreshold: 0.2,
  maxResults: 50,
  keepBelowThreshold: false,
};

const SOURCE_THRESHOLDS: Record<string, number> = {
  code: 0.3,
  docs: 0.55,
  note: 0.4,
  notes: 0.4,
  web: 0.5,
};

const log = getLogger().child({ component: 'Reranker' });

/* -------------------------------------------------------------------------- */
/*  Public factory                                                             */
/* -------------------------------------------------------------------------- */

export function createReranker(opts: RerankerOptions, env: Env) {
  const cfg = { ...DEFAULTS, ...opts } as Required<RerankerOptions>;

  const runner =
    cfg.implementation === 'workers-ai' ? new WorkersAIReranker(cfg) : new CohereReranker(cfg, env);

  return (retrieval: RetrievalResult, query: string, env: Env, traceId: string, spanId: string) =>
    runner.rerank(retrieval, query, env, traceId, spanId);
}

/* -------------------------------------------------------------------------- */
/*  Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

function mapSourceType(src: string): RetrievalToolType {
  switch (src) {
    case 'code':
      return RetrievalToolType.CODE;
    case 'doc':
    case 'docs':
      return RetrievalToolType.DOC;
    case 'note':
    case 'notes':
      return RetrievalToolType.NOTE;
    case 'web':
      return RetrievalToolType.WEB;
    default:
      return src as unknown as RetrievalToolType;
  }
}

const logistic = (x: number) => 1 / (1 + Math.exp(-x));

function thresholdFor(chunk: DocumentChunk, fallback: number) {
  return SOURCE_THRESHOLDS[chunk.metadata.sourceType as string] ?? fallback;
}

function filterAndLimit(chunks: DocumentChunk[], cfg: Partial<BaseOpts>): DocumentChunk[] {
  const filtered = cfg.keepBelowThreshold
    ? chunks
    : chunks.filter(c => {
        const score =
          (c.metadata as any).hybridScore ??
          c.metadata.rerankerScore ??
          c.metadata.relevanceScore ??
          0;
        return score >= thresholdFor(c, cfg.scoreThreshold || DEFAULTS.scoreThreshold || 0.1);
      });
  return filtered.slice(0, cfg.maxResults);
}

/* -------------------------------------------------------------------------- */
/*  Base class                                                                 */
/* -------------------------------------------------------------------------- */

abstract class BaseReranker {
  constructor(protected readonly cfg: Required<RerankerOptions>) {}

  async rerank(
    res: RetrievalResult,
    query: string,
    env: Env,
    traceId: string,
    spanId: string,
  ): Promise<RetrievalTask> {
    const t0 = performance.now();
    if (!res.chunks.length) return this.emptyTask(res, query);

    let ranked: DocumentChunk[];
    try {
      ranked = await this.rank(res.chunks, query, env);
    } catch (err) {
      log.error({ err }, 'Reranking failed – fallback to vector scores');
      ranked = this.fallback(res.chunks);
    }

    const elapsed = performance.now() - t0;
    return {
      category: mapSourceType(res.sourceType),
      query,
      chunks: filterAndLimit(ranked, this.cfg),
      sourceType: res.sourceType,
      metadata: {
        rerankerModel: this.cfg.model,
        executionTimeMs: elapsed,
        scoreThreshold: this.cfg.scoreThreshold,
        retrievalStrategy: res.metadata.retrievalStrategy,
        totalCandidates: res.metadata.totalCandidates,
      },
    };
  }

  protected emptyTask(res: RetrievalResult, query: string): RetrievalTask {
    return {
      category: mapSourceType(res.sourceType),
      query,
      chunks: [],
      sourceType: res.sourceType,
      metadata: {
        rerankerModel: this.cfg.model,
        executionTimeMs: 0,
        scoreThreshold: this.cfg.scoreThreshold,
        retrievalStrategy: res.metadata.retrievalStrategy,
        totalCandidates: res.metadata.totalCandidates,
      },
    };
  }

  protected fallback(chunks: DocumentChunk[]): DocumentChunk[] {
    return chunks
      .map(c => ({
        ...c,
        metadata: {
          ...c.metadata,
          rerankerScore: c.metadata.relevanceScore,
          hybridScore: c.metadata.relevanceScore,
        },
      }))
      .sort((a, b) => (b.metadata.hybridScore ?? 0) - (a.metadata.hybridScore ?? 0));
  }

  protected abstract rank(
    chunks: DocumentChunk[],
    query: string,
    env: Env,
  ): Promise<DocumentChunk[]>;
}

/* -------------------------------------------------------------------------- */
/*  Cohere implementation                                                      */
/* -------------------------------------------------------------------------- */

class CohereReranker extends BaseReranker {
  private readonly reranker: CohereRerank;
  constructor(cfg: Required<CohereOpts>, env: Env) {
    super(cfg);
    const apiKey = env.COHERE_API_KEY || cfg.cohereApiKey;
    this.reranker = new CohereRerank({ apiKey, model: cfg.model });
  }

  protected async rank(chunks: DocumentChunk[], query: string): Promise<DocumentChunk[]> {
    const docs = chunks.map(c => new Document({ pageContent: c.content, metadata: { id: c.id } }));
    getLogger().info({ docs }, 'Cohere reranker request');
    const out = await this.reranker.rerank(docs, query);
    getLogger().info({ out }, 'Cohere reranker response');
    return out
      .map(r => {
        const chunk = chunks[r.index];
        const vector = chunk.metadata.relevanceScore ?? 0.5;
        const rer = r.relevanceScore;
        return {
          ...chunk,
          metadata: {
            ...chunk.metadata,
            rerankerScore: rer,
            hybridScore: 0.7 * rer + 0.3 * vector,
          },
        };
      })
      .sort((a, b) => (b.metadata.hybridScore ?? 0) - (a.metadata.hybridScore ?? 0));
  }
}

/* -------------------------------------------------------------------------- */
/*  Workers‑AI implementation                                                  */
/* -------------------------------------------------------------------------- */

class WorkersAIReranker extends BaseReranker {
  protected async rank(chunks: DocumentChunk[], query: string, env: Env): Promise<DocumentChunk[]> {
    const clean = (s: string) =>
      s
        .replace(/```[\s\S]*?```/g, '<code>')
        .replace(/<[^>]+>/g, '')
        .slice(0, 1500);

    const input = {
      query: clean(query).slice(0, 500),
      contexts: chunks.map(c => ({ text: clean(c.content) })),
    };

    const out = (await (env as any).AI.run(this.cfg.model, input)) as {
      response: { id: number; score: number }[];
    };

    const allLow = out.response.every(r => r.score < -2);

    return chunks
      .map((c, i) => {
        const r = out.response.find(x => x.id === i);
        const raw = r?.score ?? -5;
        const norm = logistic(raw);
        const vector = c.metadata.relevanceScore ?? 0.5;
        const hybrid = allLow ? vector : 0.7 * norm + 0.3 * vector;
        return {
          ...c,
          metadata: {
            ...c.metadata,
            rerankerRawScore: raw,
            rerankerScore: norm,
            hybridScore: hybrid,
          },
        };
      })
      .sort((a, b) => (b.metadata.hybridScore ?? 0) - (a.metadata.hybridScore ?? 0));
  }
}

/* -------------------------------------------------------------------------- */
/*  Global‑aware reranker node                                                 */
/* -------------------------------------------------------------------------- */

export async function reranker(
  state: AgentState,
  _cfg: LangGraphRunnableConfig,
  env: Env,
): Promise<Partial<AgentState>> {
  const t0 = performance.now();
  const nodeId = 'reranker';
  const traceId = state.metadata?.traceId ?? crypto.randomUUID();
  const spanId = ObservabilityService.startSpan(env, traceId, nodeId, state);

  try {
    const tasks = mergeTasks(state.retrievals as RetrievalTask[] | undefined);
    if (!tasks.length) return finish(state, nodeId, spanId, traceId, t0, env);

    // ---------------- Global collection ----------------
    const allChunks: DocumentChunk[] = [];
    const idToTask = new Map<string, RetrievalTask>();
    tasks.forEach(t => {
      t.chunks?.forEach(c => {
        allChunks.push(c);
        idToTask.set(c.id, t);
      });
    });

    if (!allChunks.length) return finish(state, nodeId, spanId, traceId, t0, env);

    // Select one global model (simple heuristic)
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

    if (!res || !res.chunks) {
      throw new Error('Reranker returned no chunks');
    }

    // ---------------- Write scores back into tasks ----------------
    const chunkMap = new Map(res.chunks.map(c => [c.id, c] as const));

    const updatedTasks = tasks.map(t => {
      const scoredChunks = (t.chunks ?? []).map(c => chunkMap.get(c.id) ?? c);
      return {
        ...t,
        chunks: filterAndLimit(scoredChunks, DEFAULTS),
      } as RetrievalTask;
    });

    return finish({ ...state, retrievals: updatedTasks }, nodeId, spanId, traceId, t0, env);
  } catch (e) {
    const err = toDomeError(e);
    log.error({ err }, 'Reranker node failed');
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

/* -------------------------------------------------------------------------- */
/*  Helper functions                                                           */
/* -------------------------------------------------------------------------- */

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
    return {
      implementation: 'cohere',
      model: 'rerank-v3.5',
    } as CohereOpts;
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
): Partial<AgentState> {
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
