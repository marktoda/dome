import { Document as LangDoc } from '@langchain/core/documents';
import { CohereRerank } from '@langchain/cohere';
import type { DocumentChunk } from '../../../types';
import { BaseReranker, CohereOpts } from '../core';

export class CohereReranker extends BaseReranker {
  private readonly reranker: CohereRerank;

  constructor(cfg: Required<CohereOpts>, env: Env) {
    super(cfg);
    const apiKey = env.COHERE_API_KEY || cfg.cohereApiKey;
    if (!apiKey) throw new Error('Cohere API key not found.');
    this.reranker = new CohereRerank({ apiKey, model: cfg.model });
  }

  protected async rank(chunks: DocumentChunk[], query: string): Promise<DocumentChunk[]> {
    const docs = chunks.map(c => new LangDoc({ pageContent: c.content, metadata: { id: c.id } }));
    const out = await this.reranker.rerank(docs, query);
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
            hybridScore: 0.7 * rer + 0.3 * vector, // Simple weighted average
          },
        };
      })
      .sort((a, b) => (b.metadata.hybridScore ?? 0) - (a.metadata.hybridScore ?? 0));
  }
}
