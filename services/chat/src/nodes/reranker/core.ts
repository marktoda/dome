import { getLogger, logError } from '@dome/common';
import type { Document } from '@langchain/core/documents';
import { Document as LangDoc } from '@langchain/core/documents';
import { CohereRerank } from '@langchain/cohere'; // used by cohere impl
import type { RetrievalResult, RetrievalTask, DocumentChunk, RetrievalToolType } from '../../types';

/* -------------------------------------------------------------------------- */
/*  Shared helpers & enums                                                    */
/* -------------------------------------------------------------------------- */

export type ImplKind = 'cohere' | 'workers-ai';

export interface BaseOpts {
  name: string;
  scoreThreshold?: number;
  maxResults?: number;
  keepBelowThreshold?: boolean;
}

export interface WorkersAiOpts extends BaseOpts {
  implementation: 'workers-ai';
  model: '@cf/baai/bge-reranker-base';
}

export interface CohereOpts extends BaseOpts {
  implementation: 'cohere';
  model: 'rerank-v3.5';
  cohereApiKey?: string;
}

export type RerankerOptions = WorkersAiOpts | CohereOpts;

export const DEFAULTS: RerankerOptions = {
  name: 'global',
  implementation: 'cohere',
  model: 'rerank-v3.5',
  scoreThreshold: 0.2,
  maxResults: 50,
  keepBelowThreshold: false,
};

export const SOURCE_THRESHOLDS: Record<string, number> = {
  code: 0.3,
  docs: 0.55,
  note: 0.4,
  notes: 0.4,
  web: 0.5,
};

const log = getLogger().child({ component: 'Reranker-core' });

export function mapSourceType(src: string): RetrievalToolType {
  switch (src) {
    case 'code':
      return 'code' as RetrievalToolType;
    case 'doc':
    case 'docs':
      return 'doc' as RetrievalToolType;
    case 'note':
    case 'notes':
      return 'note' as RetrievalToolType;
    case 'web':
      return 'web' as RetrievalToolType;
    default:
      return src as unknown as RetrievalToolType;
  }
}

export const logistic = (x: number) => 1 / (1 + Math.exp(-x));

export function thresholdFor(chunk: DocumentChunk, fallback: number) {
  return SOURCE_THRESHOLDS[chunk.metadata.sourceType as string] ?? fallback;
}

export function filterAndLimit(chunks: DocumentChunk[], cfg: Partial<BaseOpts>): DocumentChunk[] {
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
/*  Abstract base class                                                       */
/* -------------------------------------------------------------------------- */

export abstract class BaseReranker {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected readonly log: any;

  constructor(protected readonly cfg: Required<RerankerOptions>) {
    this.log = getLogger().child({ component: 'BaseReranker' });
  }

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
      logError(err, 'Reranking failed – fallback to vector scores');
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
