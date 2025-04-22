import { VectorMeta, VectorSearchResult, VectorIndexStats } from '@dome/common';
import { getLogger, metrics } from '@dome/logging';
import { VectorWithMetadata } from '../types';
import { SiloService } from './siloService';

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

    // Log sample metadata for debugging
    if (vecs.length > 0) {
      getLogger().debug(
        {
          sampleMetadata: vecs[0].metadata,
          sampleId: vecs[0].id,
          vectorLength: vecs[0].values.length,
        },
        'Sample vector metadata for upsert',
      );
    }

    const batches =
      vecs.length > this.cfg.maxBatchSize
        ? Array.from({ length: Math.ceil(vecs.length / this.cfg.maxBatchSize) }, (_, i) =>
            vecs.slice(i * this.cfg.maxBatchSize, (i + 1) * this.cfg.maxBatchSize),
          )
        : [vecs];

    for (const batch of batches) await this.upsertBatch(batch);

    // Log index stats after upsert
    try {
      const stats = await this.idx.describe();
      // Handle both beta and post-beta versions of the API
      const statsAny = stats as any;
      const vectorCount =
        'vectorsCount' in statsAny
          ? statsAny.vectorsCount
          : 'vectorCount' in statsAny
          ? statsAny.vectorCount
          : 0;

      const dimensions =
        'dimensions' in statsAny
          ? statsAny.dimensions
          : 'config' in statsAny && statsAny.config && 'dimensions' in statsAny.config
          ? statsAny.config.dimensions
          : 0;

      getLogger().info(
        {
          vectorCount,
          dimensions,
        },
        'Vectorize index stats after upsert',
      );
    } catch (err) {
      getLogger().warn({ err }, 'Failed to get index stats after upsert');
    }

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
        getLogger().info(
          { batchSize: batch.length, first: batch[0] },
          'Successfully upserted batch to Vectorize',
        );
        return;
      } catch (err) {
        metrics.increment('vectorize.upsert.errors');

        const errorMessage = err instanceof Error ? err.message : String(err);
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
    filter: Partial<VectorMeta> = {},
    topK = 10,
  ): Promise<VectorSearchResult[]> {
    if (!vector?.length) return [];

    const t = metrics.startTimer('vectorize.query');
    metrics.increment('vectorize.query.requests');

    try {
      // Clean the filter by removing undefined and null values
      const cleanFilter = Object.fromEntries(
        Object.entries(filter).filter(([, v]) => v !== undefined && v !== null),
      ) as Partial<VectorMeta>;

      // Create a new filter object for Vectorize that can include the $in operator
      const vectorizeFilter: Record<string, any> = { ...cleanFilter };

      // Special handling for userId to include both user-specific and public vectors
      // This requires a metadata index on userId:
      // npx wrangler vectorize create-metadata-index <INDEX> --property-name=userId --type=string
      if ('userId' in cleanFilter && cleanFilter.userId) {
        const userId = cleanFilter.userId;
        // Replace the userId in the vectorizeFilter with an $in operator
        vectorizeFilter.userId = { $in: [userId, SiloService.PUBLIC_CONTENT_USER_ID] };
        getLogger().debug(
          { userId, filter: vectorizeFilter.userId },
          'Using $in operator for userId filter',
        );
        // Remove userId from cleanFilter since we're handling it specially
        delete cleanFilter.userId;
      }

      // Log the filters for debugging
      getLogger().debug(
        {
          originalFilter: filter,
          cleanFilter,
          vectorizeFilter,
        },
        'Filters for Vectorize query',
      );

      // Log query vector stats to check for zero/small vectors
      getLogger().debug(
        {
          vectorLength: vector.length,
          firstValues: vector.slice(0, 3),
          magnitude: Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0)),
        },
        'Query vector stats',
      );

      // Get index stats before query
      try {
        const stats = await this.idx.describe();
        // Handle both beta and post-beta versions of the API
        const statsAny = stats as any;
        const vectorCount =
          'vectorsCount' in statsAny
            ? statsAny.vectorsCount
            : 'vectorCount' in statsAny
            ? statsAny.vectorCount
            : 0;

        const dimensions =
          'dimensions' in statsAny
            ? statsAny.dimensions
            : 'config' in statsAny && statsAny.config && 'dimensions' in statsAny.config
            ? statsAny.config.dimensions
            : 0;

        getLogger().debug(
          {
            vectorCount,
            dimensions,
          },
          'Vectorize index stats before query',
        );
      } catch (err) {
        getLogger().warn({ err }, 'Failed to get index stats before query');
      }

      const res = await this.idx.query(vector, {
        topK,
        filter: vectorizeFilter,
        returnMetadata: true,
      });
      getLogger().info({ queryResults: res }, 'Vectorize query results');
      metrics.increment('vectorize.query.success');
      metrics.gauge('vectorize.query.results', res.matches.length);

      return res.matches.map(m => ({
        id: m.id,
        score: m.score,
        // TODO: make metadata required?
        metadata: (m.metadata ?? {}) as unknown as VectorMeta,
      }));
    } catch (err) {
      metrics.increment('vectorize.query.errors');

      const errorMessage = err instanceof Error ? err.message : String(err);
      getLogger().error({ err, filter, topK }, 'vectorize.query failed');
      throw err;
    } finally {
      t.stop();
    }
  }

  /* ---------- STATS ---------------------------------------------------- */

  public async getStats(): Promise<VectorIndexStats> {
    const info = await this.idx.describe();
    const infoAny = info as any;

    // Handle both beta and post-beta versions of the API
    const vectors =
      'vectorsCount' in infoAny
        ? infoAny.vectorsCount
        : 'vectorCount' in infoAny
        ? infoAny.vectorCount
        : 0;

    const dimension =
      'dimensions' in infoAny
        ? infoAny.dimensions
        : 'config' in infoAny && infoAny.config && 'dimensions' in infoAny.config
        ? infoAny.config.dimensions
        : 0;

    return { vectors, dimension };
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
