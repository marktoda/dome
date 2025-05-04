// Reranker utilities and node – simplified, readable & easily extensible
// =============================================================================
// This single file keeps the public surface identical while dramatically
// reducing duplication.  Add or swap reranker back‑ends by implementing the
// BaseReranker abstract class.
// =============================================================================

/* -------------------------------------------------------------------------- */
/*  Shared types & helpers                                                     */
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
import { LangGraphRunnableConfig } from '@langchain/langgraph';

/* -------------------------------- Config ---------------------------------- */

type Impl = 'cohere' | 'workers-ai';

export type RerankerOptions = WorkersAiRerankerOptions | CohereRerankerOptions;

interface WorkersAiRerankerOptions extends BaseRerankerOptions {
  implementation: 'workers-ai',
  model: keyof AiModels,
}

interface CohereRerankerOptions extends BaseRerankerOptions {
  implementation: 'cohere',
  model: string,
}

interface BaseRerankerOptions {
  name: string;
  // model?: string;
  scoreThreshold?: number;
  maxResults?: number;
  keepBelowThreshold?: boolean;
  implementation?: Impl;
  cohereApiKey?: string;
}

const DEFAULTS: RerankerOptions = {
  name: 'default',
  scoreThreshold: 0.2,
  maxResults: 20,
  model: '@cf/baai/bge-reranker-base',
  implementation: 'workers-ai',
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

export function createReranker(opts: RerankerOptions) {
  const cfg = { ...DEFAULTS, ...opts } as Required<RerankerOptions>;

  const runner =
    cfg.implementation === 'workers-ai'
      ? new WorkersAIReranker(cfg)
      : new CohereReranker(cfg);

  return (
    retrieval: RetrievalResult,
    query: string,
    env: Env,
    traceId: string,
    spanId: string,
  ) => runner.rerank(retrieval, query, env, traceId, spanId);
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

function logistic(x: number) {
  return 1 / (1 + Math.exp(-x));
}

function thresholdFor(chunk: DocumentChunk, fallback: number) {
  return SOURCE_THRESHOLDS[chunk.metadata.sourceType as string] ?? fallback;
}

function filterAndLimit(
  chunks: DocumentChunk[],
  cfg: Required<Pick<RerankerOptions, 'scoreThreshold' | 'keepBelowThreshold' | 'maxResults'>>,
): DocumentChunk[] {
  const filtered = cfg.keepBelowThreshold
    ? chunks
    : chunks.filter(c => {
      const score =
        (c.metadata as any).hybridScore ??
        c.metadata.rerankerScore ??
        c.metadata.relevanceScore ??
        0;
      return score >= thresholdFor(c, cfg.scoreThreshold);
    });

  return filtered.slice(0, cfg.maxResults);
}

/* -------------------------------------------------------------------------- */
/*  Base class                                                                 */
/* -------------------------------------------------------------------------- */

abstract class BaseReranker {
  constructor(protected readonly cfg: Required<RerankerOptions>) { }

  async rerank(
    result: RetrievalResult,
    query: string,
    env: Env,
    traceId: string,
    spanId: string,
  ): Promise<RetrievalTask> {
    const t0 = performance.now();

    if (result.chunks.length === 0) {
      return this.emptyTask(result, query);
    }

    let ranked: DocumentChunk[];
    try {
      ranked = await this.rank(result.chunks, query, env);
    } catch (err) {
      log.error({ err }, 'Reranking failed – falling back to vector score');
      ranked = this.fallbackToVector(result.chunks);
    }

    const top = filterAndLimit(ranked, this.cfg);

    const elapsed = performance.now() - t0;
    return {
      category: mapSourceType(result.sourceType),
      query,
      chunks: top,
      sourceType: result.sourceType,
      metadata: {
        rerankerModel: this.cfg.model!,
        executionTimeMs: elapsed,
        scoreThreshold: this.cfg.scoreThreshold!,
        retrievalStrategy: result.metadata.retrievalStrategy,
        totalCandidates: result.metadata.totalCandidates,
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
        rerankerModel: this.cfg.model!,
        executionTimeMs: 0,
        scoreThreshold: this.cfg.scoreThreshold!,
        retrievalStrategy: res.metadata.retrievalStrategy,
        totalCandidates: res.metadata.totalCandidates,
      },
    };
  }

  protected fallbackToVector(chunks: DocumentChunk[]): DocumentChunk[] {
    return chunks
      .map(c => ({
        ...c,
        metadata: {
          ...c.metadata,
          rerankerScore: c.metadata.relevanceScore,
          hybridScore: c.metadata.relevanceScore,
        },
      }))
      .sort((a, b) => (b.metadata.relevanceScore ?? 0) - (a.metadata.relevanceScore ?? 0));
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

  constructor(cfg: Required<RerankerOptions>) {
    super(cfg);
    this.reranker = new CohereRerank({ apiKey: cfg.cohereApiKey, model: cfg.model! });
  }

  protected async rank(chunks: DocumentChunk[], query: string): Promise<DocumentChunk[]> {
    const docs = chunks.map(
      c =>
        new Document({
          pageContent: c.content,
          metadata: { id: c.id },
        }),
    );

    const res = await this.reranker.rerank(docs, query);

    return res
      .map(r => {
        const chunk = chunks[r.index];
        const vectorScore = chunk.metadata.relevanceScore ?? 0.5;
        const rerankerScore = r.relevanceScore;
        return {
          ...chunk,
          metadata: {
            ...chunk.metadata,
            rerankerScore,
            hybridScore: 0.7 * rerankerScore + 0.3 * vectorScore,
          },
        };
      })
      .sort((a, b) => (b.metadata as any).hybridScore - (a.metadata as any).hybridScore);
  }
}

/* -------------------------------------------------------------------------- */
/*  Workers‑AI implementation                                                  */
/* -------------------------------------------------------------------------- */

class WorkersAIReranker extends BaseReranker {
  constructor(protected readonly cfg: Required<WorkersAiRerankerOptions>) {
    super(cfg);
  }

  protected async rank(chunks: DocumentChunk[], query: string, env: Env): Promise<DocumentChunk[]> {
    const clean = (s: string) =>
      s.replace(/```[\s\S]*?```/g, '<code>').replace(/<[^>]+>/g, '').slice(0, 1500);

    const input = {
      query: clean(query).slice(0, 500),
      contexts: chunks.map(c => ({ text: clean(c.content) })),
    };

    const out = (await env.AI.run(this.cfg.model, input)) as {
      response: { id: number; score: number }[];
    };

    const allLow = out.response.every(r => r.score < -2);

    return chunks
      .map((c, i) => {
        const r = out.response.find(x => x.id === i);
        const raw = r?.score ?? -5;
        const norm = logistic(raw);
        const vectorScore = c.metadata.relevanceScore ?? 0.5;
        const hybrid = allLow ? vectorScore : 0.7 * norm + 0.3 * vectorScore;
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
      .sort((a, b) => (b.metadata as any).hybridScore - (a.metadata as any).hybridScore);
  }
}

/* -------------------------------------------------------------------------- */
/*  Reranker node                                                             */
/* -------------------------------------------------------------------------- */

// The node bundles retrieval deduplication + per‑task reranking in ~80 lines.

export async function reranker(
  state: AgentState,
  _cfg: LangGraphRunnableConfig,
  env: Env,
): Promise<Partial<AgentState>> {
  const t0 = performance.now();
  const nodeId = 'reranker_node';
  const traceId = state.metadata?.traceId ?? crypto.randomUUID();
  const spanId = ObservabilityService.startSpan(env, traceId, nodeId, state);

  try {
    const tasks = mergeTasks((state.retrievals ?? []) as RetrievalTask[]);
    if (!tasks.length) return finish(state, nodeId, spanId, traceId, t0, env);

    const lastUserMsg = [...(state.messages ?? [])]
      .reverse()
      .find(m => m.role === 'user')?.content;

    const reranked: RetrievalTask[] = [];

    for (const task of tasks) {
      if (!task.chunks?.length) continue;

      const rerank = createReranker({
        ...DEFAULTS,
        name: `reranker-${task.category}`,
      });

      const res = await rerank(
        {
          query: task.query ?? lastUserMsg ?? '',
          chunks: task.chunks,
          sourceType: task.sourceType ?? '',
          metadata: task.metadata ?? {
            executionTimeMs: 0,
            retrievalStrategy: '0',
            totalCandidates: 0,

          },
        },
        task.query ?? lastUserMsg ?? '',
        env,
        traceId,
        spanId,
      );

      reranked.push({ ...task, chunks: res.chunks, metadata: res.metadata });
    }

    return finish({ ...state, retrievals: reranked }, nodeId, spanId, traceId, t0, env);
  } catch (e) {
    const err = toDomeError(e);
    log.error({ err }, 'Reranker node failed');
    const elapsed = performance.now() - t0;
    ObservabilityService.endSpan(env, traceId, spanId, nodeId, state, state, elapsed);
    return {
      metadata: {
        ...state.metadata,
        errors: [...(state.metadata?.errors ?? []), { node: nodeId, message: err.message, timestamp: Date.now() }],
      },
    };
  }
}

/* ------------------------ node‑level helpers ------------------------------ */

function mergeTasks(tasks: RetrievalTask[]): RetrievalTask[] {
  const map = new Map<string, RetrievalTask>();
  for (const t of tasks) {
    const key = `${t.category}:${t.query}`;
    map.set(key, {
      ...t,
      chunks: [...(map.get(key)?.chunks ?? []), ...(t.chunks ?? [])],
    });
  }
  return [...map.values()];
}

function selectModel(task: RetrievalTask, env: Env) {
  const query = (task.query ?? '').toLowerCase();
  const multilingual = /[^\x00-\x7F]/.test(query);
  const isCode = task.sourceType === 'code' || query.includes('code');

  if ((env as any).COHERE_API_KEY) {
    return multilingual ? 'rerank-multilingual-v2.0' : 'rerank-english-v2.0';
  }

  if (isCode) return '@cf/baai/bge-reranker-large';
  return multilingual ? '@cf/baai/bge-reranker-m3' : '@cf/baai/bge-reranker-base';
}

function finish(
  newState: AgentState,
  nodeId: string,
  spanId: string,
  traceId: string,
  t0: number,
  env: Env,
) {
  const elapsed = performance.now() - t0;
  ObservabilityService.endSpan(env, traceId, spanId, nodeId, newState, newState, elapsed);
  return {
    retrievals: newState.retrievals,
    metadata: {
      ...newState.metadata,
      nodeTimings: { ...newState.metadata?.nodeTimings, [nodeId]: elapsed },
      currentNode: nodeId,
    },
  } as Partial<AgentState>;
}
