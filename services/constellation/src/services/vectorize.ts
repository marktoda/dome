// vectorize.service.ts
import { VectorMeta, VectorSearchResult, VectorIndexStats, PUBLIC_USER_ID } from '@dome/common';
import { VectorWithMetadata } from '../types';
import {
  getLogger,
  logError,
  trackOperation,
  constellationMetrics as metrics,
} from '../utils/logging';

const logger = getLogger();
import { assertValid, VectorizeError, toDomeError } from '../utils/errors';
import { sliceIntoBatches } from '../utils/batching';
import { retryAsync, RetryConfig } from '../utils/retry';

/* ------------------------------------------------------------------ */
/*  configuration                                                     */
/* ------------------------------------------------------------------ */

export interface VectorizeConfig {
  /** Cloudflare recommends ≤ 100 vectors / upsert */
  maxBatchSize: number;
  /** max retry attempts for a failed batch */
  retryAttempts: number;
  /** delay (ms) for linear back-off */
  retryDelay: number;
}

export const DEFAULT_VECTORIZE_CONFIG: VectorizeConfig = {
  maxBatchSize: 100,
  retryAttempts: 3,
  retryDelay: 1_000,
};

/* ------------------------------------------------------------------ */
/*  helpers                                                           */
/* ------------------------------------------------------------------ */

const uuid = () => crypto.randomUUID();

/** Handle beta / GA field names once, not inline everywhere */
function getVectorCount(d: any): number {
  return d?.vectorsCount ?? d?.vectorCount ?? 0;
}
function getDimensions(d: any): number {
  return d?.dimensions ?? d?.config?.dimensions ?? 0;
}

/* ------------------------------------------------------------------ */
/*  service                                                           */
/* ------------------------------------------------------------------ */

export class VectorizeService {
  private readonly cfg: VectorizeConfig;

  constructor(private readonly idx: VectorizeIndex, cfg: Partial<VectorizeConfig> = {}) {
    this.cfg = { ...DEFAULT_VECTORIZE_CONFIG, ...cfg };
  }

  /* ---------------------------- UPSERT ---------------------------- */

  public async upsert(vecs: VectorWithMetadata[]): Promise<void> {
    const requestId = uuid();

    return trackOperation(
      'vectorize_upsert',
      async () => {
        assertValid(Array.isArray(vecs), 'Vectors array is required', { requestId });
        if (vecs.length === 0) {
          logger.warn({ requestId }, 'Upsert called with empty input');
          return;
        }

        const batches = sliceIntoBatches(vecs, this.cfg.maxBatchSize);
        const timer = metrics.startTimer('vectorize.upsert');
        metrics.counter('vectorize.upsert.requests', 1);
        metrics.gauge('vectorize.upsert.batch_size', vecs.length);

        /* ---- batch loop ---- */
        for (let i = 0; i < batches.length; i++) {
          await this.upsertBatch(batches[i], requestId, {
            batchIndex: i + 1,
            totalBatches: batches.length,
          });
        }

        /* ---- stats ---- */
        try {
          const stats = await this.idx.describe();
          const vectorCount = getVectorCount(stats);
          const dimensions = getDimensions(stats);

          metrics.gauge('vectorize.total_vectors', vectorCount);
          logger.info(
            { requestId, vectorCount, dimensions },
            'Vectorize index stats after upsert',
          );
        } catch (err) {
          logError(
            toDomeError(err, 'Failed to get index stats', { requestId }),
            'Stat retrieval failed',
          );
        } finally {
          timer.stop();
        }
      },
      { vectorCount: vecs.length, requestId },
    );
  }

  /* Upsert one batch with retries */
  private async upsertBatch(
    batch: VectorWithMetadata[],
    requestId: string,
    { batchIndex, totalBatches }: { batchIndex: number; totalBatches: number },
  ): Promise<void> {
    const baseCtx = {
      requestId,
      batchIndex,
      totalBatches,
      batchSize: batch.length,
    };

    const retryConfig: RetryConfig = {
      attempts: this.cfg.retryAttempts,
      delayMs: this.cfg.retryDelay,
      operationName: 'vectorize-upsertBatch',
    };

    try {
      await retryAsync(
        async currentAttempt => {
          await this.idx.upsert(
            batch.map(v => ({
              id: v.id,
              values: v.values,
              metadata: v.metadata as any, // Reverting due to type incompatibility with VectorizeIndex
            })),
          );
          logger.info({ ...baseCtx, attempt: currentAttempt }, 'Batch upserted');
        },
        retryConfig,
        baseCtx,
      );

      metrics.counter('vectorize.upsert.success', 1);
      metrics.counter('vectorize.upsert.vectors_stored', batch.length);
    } catch (err) {
      metrics.counter('vectorize.upsert.errors', 1);
      const domeErr = toDomeError(err, 'Vectorize upsert failed after retries', {
        ...baseCtx,
        retryAttempts: this.cfg.retryAttempts,
      });
      logError(domeErr, 'Upsert batch failed definitively'); // logError is from utils/logging
      throw domeErr;
    }
  }

  /* ----------------------------- QUERY --------------------------- */

  public async query(
    vector: number[],
    filter: Partial<VectorMeta> = {},
    topK = 10,
  ): Promise<VectorSearchResult[]> {
    const requestId = uuid();

    return trackOperation(
      'vectorize_query',
      async () => {
        assertValid(vector.length > 0, 'Vector must not be empty', { requestId });
        assertValid(topK > 0 && topK <= 1000, 'topK 1–1000', { requestId });

        /* merge PUBLIC_USER_ID automatically */
        const vf = {
          ...filter,
          ...(filter.userId ? { userId: { $in: [filter.userId, PUBLIC_USER_ID] } } : {}),
        };

        logger.info({ vf }, 'Querying vectorize index');
        const res = await this.idx.query(vector, {
          topK,
          filter: vf as unknown as VectorizeVectorMetadataFilter,
          returnMetadata: true,
        });

        metrics.counter('vectorize.query.success', 1);
        metrics.gauge('vectorize.query.results', res.matches.length);

        return res.matches.map(m => ({
          id: m.id,
          score: m.score,
          metadata: (m.metadata ?? {}) as unknown as VectorMeta,
        }));
      },
      { requestId, topK },
    );
  }

  /* ----------------------------- STATS -------------------------- */

  public async getStats(): Promise<VectorIndexStats> {
    const info = await this.idx.describe();
    const stats = {
      vectors: getVectorCount(info),
      dimension: getDimensions(info),
    };

    metrics.gauge('vectorize.total_vectors', stats.vectors);
    logger.info(stats, 'Vectorize index statistics');

    return stats;
  }
}

/* ------------------------------------------------------------------ */
/*  factory                                                           */
/* ------------------------------------------------------------------ */

export const createVectorizeService = (
  vectorize: VectorizeIndex,
  cfg: Partial<VectorizeConfig> = {},
): VectorizeService => {
  assertValid(!!vectorize, 'VECTORIZE binding is required');
  logger.info({ cfg }, 'Creating VectorizeService');
  return new VectorizeService(vectorize, cfg);
};
