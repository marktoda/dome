import { NoteVectorMeta, VectorSearchResult, VectorIndexStats } from '@dome/common';
import { getLogger, metrics } from '@dome/logging';
import { VectorWithMetadata } from '../types';

/* ------------------------------------------------------------------------ */
/*  config                                                                  */
/* ------------------------------------------------------------------------ */

export interface VectorizeConfig {
  maxBatchSize: number; // CF recommend ≤100
  retryAttempts: number;
  retryDelay: number; // ms
}

export const DEFAULT_VECTORIZE_CONFIG: VectorizeConfig = {
  maxBatchSize: 100,
  retryAttempts: 3,
  retryDelay: 1_000,
};

/* ------------------------------------------------------------------------ */
/*  service                                                                 */
/* ------------------------------------------------------------------------ */

export class VectorizeService {
  private readonly cfg: VectorizeConfig;
  constructor(private readonly idx: VectorizeIndex, cfg: Partial<VectorizeConfig> = {}) {
    this.cfg = { ...DEFAULT_VECTORIZE_CONFIG, ...cfg };
  }

  /* ---------- UPSERT --------------------------------------------------- */

  public async upsert(vecs: VectorWithMetadata[]): Promise<void> {
    if (!vecs.length) {
      getLogger().warn('upsert: empty input');
      return;
    }

    const t = metrics.startTimer('vectorize.upsert');
    metrics.increment('vectorize.upsert.requests');
    metrics.gauge('vectorize.upsert.batch_size', vecs.length);

    const batches =
      vecs.length > this.cfg.maxBatchSize
        ? Array.from({ length: Math.ceil(vecs.length / this.cfg.maxBatchSize) }, (_, i) =>
            vecs.slice(i * this.cfg.maxBatchSize, (i + 1) * this.cfg.maxBatchSize),
          )
        : [vecs];

    for (const batch of batches) await this.upsertBatch(batch);
    t.stop();
  }

  private async upsertBatch(batch: VectorWithMetadata[]) {
    for (let attempt = 1; attempt <= this.cfg.retryAttempts; attempt++) {
      try {
        await this.idx.upsert(
          batch.map(v => ({
            id: v.id,
            values: v.values,
            metadata: v.metadata as any,
          })),
        );
        metrics.increment('vectorize.upsert.success');
        return;
      } catch (err) {
        metrics.increment('vectorize.upsert.errors');
        getLogger().error(
          { err, attempt, max: this.cfg.retryAttempts, size: batch.length },
          'vectorize.upsert failed',
        );
        if (attempt < this.cfg.retryAttempts)
          await new Promise(r => setTimeout(r, this.cfg.retryDelay));
        else throw err;
      }
    }
  }

  /* ---------- QUERY ---------------------------------------------------- */

  public async query(
    vector: number[],
    filter: Partial<NoteVectorMeta> = {},
    topK = 10,
  ): Promise<VectorSearchResult[]> {
    if (!vector?.length) return [];

    const t = metrics.startTimer('vectorize.query');
    metrics.increment('vectorize.query.requests');

    try {
      const res = await this.idx.query(vector, { topK, filter, returnMetadata: true });
      metrics.increment('vectorize.query.success');
      metrics.gauge('vectorize.query.results', res.matches.length);

      return res.matches.map(m => ({
        id: m.id,
        score: m.score,
        // metadata is optional in SDK type, so supply a fallback object first,
        // then cast to our stricter NoteVectorMeta to satisfy TS.
        // TODO: make metadata required?
        metadata: (m.metadata ?? {}) as unknown as NoteVectorMeta,
      }));
    } catch (err) {
      metrics.increment('vectorize.query.errors');
      getLogger().error({ err, filter, topK }, 'vectorize.query failed');
      throw err;
    } finally {
      t.stop();
    }
  }

  /* ---------- STATS ---------------------------------------------------- */

  public async getStats(): Promise<VectorIndexStats> {
    const info = await this.idx.describe();
    const dim = 'dimensions' in info.config ? info.config.dimensions : 0;
    return { vectors: info.vectorsCount, dimension: dim };
  }
}

/* ------------------------------------------------------------------------ */
/*  factory                                                                 */
/* ------------------------------------------------------------------------ */

export const createVectorizeService = (
  vectorize: VectorizeIndex,
  cfg?: Partial<VectorizeConfig>,
): VectorizeService => {
  if (!vectorize) throw new Error('VECTORIZE binding is undefined');
  return new VectorizeService(vectorize, cfg);
};
