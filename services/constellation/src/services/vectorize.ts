import { VectorMeta, VectorSearchResult, VectorIndexStats, PUBLIC_USER_ID } from '@dome/common';
import { VectorWithMetadata } from '../types';
import {
  getLogger,
  logError,
  trackOperation,
  sanitizeForLogging,
  constellationMetrics as metrics
} from '../utils/logging';
import {
  assertValid,
  assertExists,
  VectorizeError,
  toDomeError
} from '../utils/errors';

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
    const requestId = crypto.randomUUID();
    
    return trackOperation(
      'vectorize_upsert',
      async () => {
        assertValid(Array.isArray(vecs), 'Vectors array is required', { requestId });
        
        if (!vecs.length) {
          getLogger().warn({ requestId, operation: 'upsert' }, 'Upsert called with empty input');
          return;
        }

        // Standard metrics tracking
        const timer = metrics.startTimer('vectorize.upsert');
        metrics.counter('vectorize.upsert.requests', 1);
        metrics.gauge('vectorize.upsert.batch_size', vecs.length);

        try {
          // Log sample metadata for debugging (sanitized)
          if (vecs.length > 0) {
            getLogger().debug(
              {
                requestId,
                sampleMetadata: sanitizeForLogging(vecs[0].metadata),
                sampleId: vecs[0].id,
                vectorLength: vecs[0].values.length,
                totalVectors: vecs.length,
                operation: 'upsert'
              },
              'Sample vector metadata for upsert',
            );
          }

          // Split into batches if needed
          const batches =
            vecs.length > this.cfg.maxBatchSize
              ? Array.from({ length: Math.ceil(vecs.length / this.cfg.maxBatchSize) }, (_, i) =>
                  vecs.slice(i * this.cfg.maxBatchSize, (i + 1) * this.cfg.maxBatchSize),
                )
              : [vecs];

          // Log batching information
          if (batches.length > 1) {
            getLogger().info(
              {
                requestId,
                totalVectors: vecs.length,
                batchCount: batches.length,
                batchSize: this.cfg.maxBatchSize,
                operation: 'upsert'
              },
              `Splitting upsert into ${batches.length} batches`
            );
          }

          // Process each batch with tracking
          for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            await this.upsertBatch(batch, requestId, {
              batchIndex: i + 1,
              totalBatches: batches.length
            });
          }

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
                requestId,
                vectorCount,
                dimensions,
                operation: 'upsert'
              },
              'Vectorize index stats after upsert',
            );
            
            metrics.gauge('vectorize.total_vectors', vectorCount);
          } catch (err) {
            const domeError = toDomeError(err, 'Failed to get index stats after upsert', {
              requestId,
              operation: 'getIndexStats'
            });
            logError(domeError, 'Failed to retrieve vectorize index statistics');
          }

          // Track successful operation
          metrics.trackOperation('vectorize_upsert', true, {
            vectorCount: String(vecs.length),
            batchCount: String(batches.length),
            requestId
          });
        } catch (error) {
          // Track failure metrics
          metrics.trackOperation('vectorize_upsert', false, {
            vectorCount: String(vecs.length),
            requestId
          });
          
          // Convert to appropriate error type and rethrow
          const domeError = new VectorizeError(
            'Failed to upsert vectors',
            {
              requestId,
              vectorCount: vecs.length,
              operation: 'upsert'
            },
            error instanceof Error ? error : undefined
          );
          
          throw domeError;
        } finally {
          timer.stop();
        }
      },
      { vectorCount: vecs.length, requestId }
    );
  }

  /**
   * Upsert a batch of vectors with retry logic
   * @param batch Batch of vectors to upsert
   * @param requestId Request ID for correlation
   * @param batchInfo Information about batch position in sequence
   */
  private async upsertBatch(
    batch: VectorWithMetadata[],
    requestId: string = crypto.randomUUID(),
    batchInfo: { batchIndex?: number, totalBatches?: number } = {}
  ) {
    return trackOperation(
      'vectorize_upsert_batch',
      async () => {
        const { batchIndex, totalBatches } = batchInfo || {};
        const batchLogContext = {
          requestId,
          batchSize: batch.length,
          batchIndex,
          totalBatches,
          operation: 'upsertBatch'
        };
        
        // Log batch processing start
        if (batchIndex && totalBatches) {
          getLogger().info(
            batchLogContext,
            `Processing batch ${batchIndex}/${totalBatches} with ${batch.length} vectors`
          );
        } else {
          getLogger().info(
            batchLogContext,
            `Processing batch with ${batch.length} vectors`
          );
        }
        
        // Try with retries
        for (let attempt = 1; attempt <= this.cfg.retryAttempts; attempt++) {
          try {
            const vectorIds = await this.idx.upsert(
              batch.map(v => ({
                id: v.id,
                values: v.values,
                metadata: v.metadata as any,
              })),
            );
            
            // Track success metrics
            metrics.counter('vectorize.upsert.success', 1);
            metrics.counter('vectorize.upsert.vectors_stored', batch.length);
            
            getLogger().info(
              {
                ...batchLogContext,
                firstVectorId: batch[0]?.id,
                vectorCount: batch.length,
                attempt,
                success: true
              },
              'Successfully upserted batch to Vectorize',
            );
            return;
          } catch (err) {
            // Track error metrics
            metrics.counter('vectorize.upsert.errors', 1, {
              attempt: String(attempt)
            });

            const domeError = toDomeError(err, 'Vectorize upsert batch failed', {
              ...batchLogContext,
              attempt,
              maxAttempts: this.cfg.retryAttempts
            });

            // If we have more retries, log as warning and retry
            if (attempt < this.cfg.retryAttempts) {
              const backoffMs = this.cfg.retryDelay * attempt; // Linear backoff
              
              getLogger().warn(
                {
                  ...batchLogContext,
                  error: domeError.message,
                  attempt,
                  maxAttempts: this.cfg.retryAttempts,
                  nextRetryMs: backoffMs
                },
                `Vectorize upsert failed (attempt ${attempt}/${this.cfg.retryAttempts}), retrying...`
              );
              
              await new Promise(r => setTimeout(r, backoffMs));
            } else {
              // Last attempt failed, log as error and throw
              logError(domeError, 'Vectorize upsert failed after all retry attempts');
              throw domeError;
            }
          }
        }
      },
      {
        batchSize: batch.length,
        requestId,
        batchIndex: batchInfo?.batchIndex || 0,
        totalBatches: batchInfo?.totalBatches || 0
      }
    );
  }

  /* ---------- QUERY ---------------------------------------------------- */

  /**
   * Query for similar vectors with enhanced logging and error handling
   */
  public async query(
    vector: number[],
    filter: Partial<VectorMeta> = {},
    topK = 10,
  ): Promise<VectorSearchResult[]> {
    const requestId = crypto.randomUUID();
    
    return trackOperation(
      'vectorize_query',
      async () => {
        // Validate inputs
        assertValid(Array.isArray(vector), 'Vector is required for query', { requestId });
        assertValid(vector.length > 0, 'Vector must not be empty', { requestId });
        assertValid(topK > 0 && topK <= 1000, 'topK must be between 1 and 1000', {
          requestId,
          providedTopK: topK
        });

        const timer = metrics.startTimer('vectorize.query');
        metrics.counter('vectorize.query.requests', 1);
        
        try {
          // Clean the filter by removing undefined and null values
          const cleanFilter = Object.fromEntries(
            Object.entries(filter).filter(([, v]) => v !== undefined && v !== null),
          ) as Partial<VectorMeta>;

          // Create a new filter object for Vectorize that can include the $in operator
          const vectorizeFilter: Record<string, any> = { ...cleanFilter };

          // Special handling for userId to include both user-specific and public vectors
          if ('userId' in cleanFilter && cleanFilter.userId) {
            const userId = cleanFilter.userId;
            // Replace the userId in the vectorizeFilter with an $in operator
            // Include both the user's content and public content in the search
            vectorizeFilter.userId = { $in: [userId, PUBLIC_USER_ID] };
            getLogger().debug(
              { requestId, userId, filter: vectorizeFilter.userId, operation: 'query' },
              'Using $in operator for userId filter to include public content',
            );
            // Remove userId from cleanFilter since we're handling it specially
            delete cleanFilter.userId;
          }

          // Calculate vector magnitude for quality check
          const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
          
          // Warn if vector magnitude is very small
          if (magnitude < 0.1) {
            getLogger().warn(
              {
                requestId,
                vectorLength: vector.length,
                magnitude,
                operation: 'query'
              },
              'Query vector has very small magnitude, may yield poor results'
            );
          }
          
          // Log query parameters with sanitized filters
          getLogger().info(
            {
              requestId,
              vectorLength: vector.length,
              firstValues: vector.slice(0, 3),
              magnitude,
              topK,
              originalFilter: sanitizeForLogging(filter),
              vectorizeFilter: sanitizeForLogging(vectorizeFilter),
              operation: 'query'
            },
            'Executing vectorize query',
          );

          // Execute the query
          const res = await this.idx.query(vector, {
            topK,
            filter: vectorizeFilter,
            returnMetadata: true,
          });
          
          // Track success metrics
          metrics.counter('vectorize.query.success', 1);
          metrics.gauge('vectorize.query.results', res.matches.length);
          
          // Log results summary (not the full results to avoid large logs)
          getLogger().info(
            {
              requestId,
              matchCount: res.matches.length,
              topScore: res.matches[0]?.score,
              operation: 'query',
              executionTimeMs: timer.stop()
            },
            `Vectorize query returned ${res.matches.length} results`
          );

          // Track detailed metrics about the results
          if (res.matches.length > 0) {
            const scores = res.matches.map(m => m.score);
            const avgScore = scores.reduce((sum, score) => sum + score, 0) / scores.length;
            
            metrics.gauge('vectorize.query.avg_score', avgScore);
            metrics.gauge('vectorize.query.max_score', Math.max(...scores));
          }
          
          // Map to standardized result format
          return res.matches.map(m => ({
            id: m.id,
            score: m.score,
            metadata: (m.metadata ?? {}) as unknown as VectorMeta,
          }));
        } catch (err) {
          metrics.counter('vectorize.query.errors', 1);
          
          // Convert to domain error
          const domeError = new VectorizeError(
            'Vector query failed',
            {
              requestId,
              vectorLength: vector?.length,
              operation: 'query'
            },
            err instanceof Error ? err : undefined
          );
          
          logError(domeError, 'Vectorize query operation failed');
          
          // Track detailed error metrics
          metrics.trackOperation('vectorize_query', false, {
            requestId,
            errorType: (domeError as any).code || 'UNKNOWN_ERROR'
          });
          
          throw domeError;
        } finally {
          try {
            timer.stop();
          } catch (e) {
            // Timer may already be stopped
          }
        }
      },
      { topK, filterCount: Object.keys(filter).length, requestId }
    );
  }

  /* ---------- STATS ---------------------------------------------------- */

  /**
   * Get statistics about the vector index
   * @returns Vector index statistics
   */
  public async getStats(): Promise<VectorIndexStats> {
    return trackOperation(
      'get_vectorize_stats',
      async () => {
        try {
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

          // Log stats for monitoring
          getLogger().info(
            {
              vectors,
              dimension,
              operation: 'getStats'
            },
            'Retrieved vectorize index statistics'
          );
          
          // Update metrics
          metrics.gauge('vectorize.total_vectors', vectors);
          
          return { vectors, dimension };
        } catch (error) {
          const domeError = toDomeError(
            error,
            'Failed to retrieve vector index statistics',
            { operation: 'getStats' }
          );
          
          logError(domeError, 'Error getting vectorize index stats');
          throw domeError;
        }
      },
      {}
    );
  }
}

/* ------------------------------------------------------------------------ */
/*  factory                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * Create a vectorize service instance with validation
 * @param vectorize Vectorize index instance
 * @param cfg Configuration options
 * @returns Configured VectorizeService instance
 */
export const createVectorizeService = (
  vectorize: VectorizeIndex,
  cfg?: Partial<VectorizeConfig>,
): VectorizeService => {
  assertValid(!!vectorize, 'VECTORIZE binding is required', {
    service: 'constellation',
    operation: 'createVectorizeService'
  });
  
  getLogger().info(
    {
      config: cfg ? { ...cfg } : 'default',
      operation: 'createVectorizeService'
    },
    'Creating vectorize service'
  );
  
  return new VectorizeService(vectorize, cfg);
};
