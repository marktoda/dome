import { Bindings } from '../types';
import { ServiceError } from '@dome/common';

/* -------------------------------------------------------------------------- */
/*                               Configuration                                */
/* -------------------------------------------------------------------------- */

const DEFAULT_MODEL = '@cf/baai/bge-base-en-v1.5';
const DEFAULT_DIM = 768;
const MAX_BATCH = 20;

/* -------------------------------------------------------------------------- */
/*                              Utility helpers                               */
/* -------------------------------------------------------------------------- */

function normaliseVectorResp(resp: any): number[] | undefined {
  if (Array.isArray(resp?.data?.[0])) return resp.data[0] as number[]; // Workers AI
  if (resp?.data?.[0]?.embedding) return resp.data[0].embedding as number[]; // OpenAI style
  return undefined;
}

/* -------------------------------------------------------------------------- */
/*                              EmbeddingService                              */
/* -------------------------------------------------------------------------- */

export class EmbeddingService {
  constructor(
    private readonly model: string = DEFAULT_MODEL,
    private readonly dimension: number = DEFAULT_DIM,
    private readonly maxBatch: number = MAX_BATCH,
  ) {}

  /* ---------------------- New canonical API ---------------------- */
  async generate(env: Bindings, text: string): Promise<number[]> {
    const t = this.preprocess(text);
    if (!env.AI) throw new ServiceError('Workers AI binding missing');

    try {
      const resp = await env.AI.run(this.model, { text: t });
      const vec = normaliseVectorResp(resp);
      if (vec && vec.length === this.dimension) return vec;
      throw new ServiceError('Embedding dimension mismatch', {
        context: { expected: this.dimension, got: vec?.length },
      });
    } catch (err) {
      throw new ServiceError('Failed to generate embedding', {
        cause: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  async generateBatch(env: Bindings, texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.maxBatch) {
      const slice = texts.slice(i, i + this.maxBatch);
      const vecs = await Promise.all(slice.map(t => this.generate(env, t)));
      out.push(...vecs);
    }
    return out;
  }

  /* ------------------ Legacy compatibility wrappers ------------------ */
  /** @deprecated use generate() */
  generateEmbedding(env: Bindings, text: string) {
    return this.generate(env, text);
  }

  /** @deprecated use generateBatch() */
  generateEmbeddings(env: Bindings, texts: string[]) {
    return this.generateBatch(env, texts);
  }

  /* splitTextIntoChunks retained for compatibility */
  splitTextIntoChunks(text: string, maxChunk = 2048): string[] {
    const chunks: string[] = [];
    const paras = text.split(/\n\s*\n/);
    let cur = '';
    for (const p of paras) {
      if (cur.length + p.length > maxChunk && cur) {
        chunks.push(cur.trim());
        cur = '';
      }
      if (p.length > maxChunk) {
        for (let i = 0; i < p.length; i += maxChunk) chunks.push(p.slice(i, i + maxChunk));
      } else {
        cur += p + '\n\n';
      }
    }
    if (cur.trim()) chunks.push(cur.trim());
    return chunks;
  }

  /* ------------------------- internal ------------------------- */
  preprocess(text: string): string {
    let t = text.trim().replace(/\s+/g, ' ');
    if (t.length < 3) t = `${t} ${t} query search`;
    return t.length > 8192 ? t.slice(0, 8192) : t;
  }
}

export const embeddingService = new EmbeddingService();
