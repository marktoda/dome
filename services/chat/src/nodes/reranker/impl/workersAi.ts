import { getLogger } from '@dome/common';
import type { DocumentChunk } from '../../../types';
import { BaseReranker, WorkersAiOpts, logistic } from '../core';

export class WorkersAIReranker extends BaseReranker {
  protected async rank(chunks: DocumentChunk[], query: string, env: Env): Promise<DocumentChunk[]> {
    const log = getLogger().child({ component: 'WorkersAIReranker' });

    // Clean input text to avoid issues with code blocks, HTML, or long content
    const clean = (s: string) =>
      s
        .replace(/```[\s\S]*?```/g, '<code>')
        .replace(/<[^>]+>/g, '')
        .slice(0, 1500);

    // Prepare input for Workers AI format
    const input = {
      query: clean(query).slice(0, 500),
      contexts: chunks.map(c => ({ text: clean(c.content) })),
    };

    // Call Workers AI
    if (!(env as any).AI) {
      log.warn('Workers AI not available in this environment, falling back to vector scores');
      return this.fallback(chunks);
    }

    try {
      const out = (await (env as any).AI.run(this.cfg.model, input)) as {
        response: { id: number; score: number }[];
      };

      // Check if all scores are unusually low, which might indicate irrelevant results
      const allLow = out.response.every(r => r.score < -2);

      // Map results back to chunks with scores and sort by hybrid score
      return chunks
        .map((c, i) => {
          const r = out.response.find(x => x.id === i);
          const raw = r?.score ?? -5;
          const norm = logistic(raw); // Transform score to 0-1 range
          const vector = c.metadata.relevanceScore ?? 0.5;
          // Use vector score as fallback if all reranker scores are low
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
    } catch (err) {
      log.error({ err }, 'Workers AI reranking failed');
      return this.fallback(chunks);
    }
  }
}
