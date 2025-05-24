import { VectorMeta, VectorSearchResult, ParsedQueueMessage, NewContentMessage, SiloContentItem } from '@dome/common';
import { z } from 'zod';
import { wrapServiceCall } from '@dome/common';
import {
  getLogger,
  logError,
  trackOperation,
  constellationMetrics as metrics,
} from '../utils/constellationLogging';
import { toDomeError } from '../utils/errors';
import { domeAssertValid as assertValid } from '@dome/common/errors';

const runWithLog = wrapServiceCall('constellation');

export async function embed(this: any, job: SiloContentItem) {
  const requestId = crypto.randomUUID();
  await runWithLog(
    {
      service: 'constellation',
      op: 'embed',
      content: job.id,
      user: job.userId,
      requestId,
      ...this.env,
    },
    async () => {
      try {
        assertValid(!!job, 'Content item is required', { requestId });
        assertValid(!!job.id, 'Content ID is required', {
          requestId,
          operation: 'embed',
        });

        metrics.counter('rpc.embed.requests', 1);

        getLogger().info(
          {
            contentId: job.id,
            userId: job.userId,
            contentType: job.category || job.mimeType || 'unknown',
            requestId,
            operation: 'embed',
          },
          'Processing RPC embed request',
        );

        const msg: ParsedQueueMessage<NewContentMessage> = {
          id: job.id,
          timestamp: Date.now(),
          body: {
            id: job.id,
            userId: job.userId,
            category: job.category,
            mimeType: job.mimeType,
            createdAt: job.createdAt,
          },
        };

        const processed = await this.embedBatch([msg], undefined, requestId);

        metrics.counter('rpc.embed.success', 1);
        metrics.trackOperation('rpc_embed', true, {
          requestId,
          contentId: job.id,
        });

        getLogger().info(
          {
            contentId: job.id,
            processed,
            success: processed === 1,
            requestId,
            operation: 'embed',
          },
          `RPC embed request ${processed === 1 ? 'succeeded' : 'failed'}`,
        );
      } catch (error) {
        metrics.counter('rpc.embed.errors', 1);

        const domeError = toDomeError(error, `Failed to embed content ID: ${job.id}`, {
          contentId: job.id,
          userId: job.userId,
          requestId,
          operation: 'embed',
        });

        logError(domeError, 'RPC embed request failed');

        metrics.trackOperation('rpc_embed', false, {
          requestId,
          contentId: job.id,
          errorType: domeError.code,
        });

        throw domeError;
      }
    },
  );
}

export async function query(this: any, text: string, filter: Partial<VectorMeta>, topK = 10): Promise<VectorSearchResult[] | { error: unknown }> {
  const requestId = crypto.randomUUID();

  return runWithLog(
    {
      service: 'constellation',
      op: 'query',
      filter,
      topK,
      requestId,
      ...this.env,
    },
    async () => {
      try {
        assertValid(typeof text === 'string', 'Text query is required', { requestId });
        assertValid(text.trim().length > 0, 'Query text cannot be empty', { requestId });
        assertValid(topK > 0 && topK <= 1000, 'topK must be between 1 and 1000', {
          requestId,
          providedTopK: topK,
        });

        metrics.counter('rpc.query.requests', 1);
        metrics.gauge('rpc.query.text_length', text.length);

        getLogger().info(
          {
            query: text,
            filterKeys: Object.keys(filter),
            topK,
            requestId,
            operation: 'query',
          },
          'Processing vector search query',
        );

        const { preprocessor, embedder, vectorize } = this.services;

        const norm = preprocessor.normalize(text);

        if (!norm) {
          getLogger().warn(
            { requestId, operation: 'query' },
            'Normalization produced empty text, returning empty results',
          );

          metrics.counter('rpc.query.empty_norm', 1);
          return [];
        }

        getLogger().debug(
          {
            requestId,
            originalLength: text.length,
            normalizedLength: norm.length,
            operation: 'query',
          },
          'Successfully normalized query text',
        );

        const [queryVec] = await embedder.embed([norm]);

        getLogger().debug(
          {
            requestId,
            vectorLength: queryVec.length,
            operation: 'query',
          },
          'Generated embedding vector for query',
        );

        const results = await vectorize.query(queryVec, filter, topK);

        getLogger().info(
          {
            requestId,
            resultCount: results.length,
            topScore: results.length > 0 ? results[0].score : 0,
            operation: 'query',
          },
          `Query returned ${results.length} results`,
        );

        metrics.counter('rpc.query.success', 1);
        metrics.gauge('rpc.query.results', results.length);
        metrics.trackOperation('vector_query', true, {
          requestId,
          resultCount: String(results.length),
        });

        return results;
      } catch (error) {
        metrics.counter('rpc.query.errors', 1);

        const domeError = toDomeError(error, 'Vector query failed', {
          requestId,
          operation: 'query',
          textLength: text?.length,
          filterKeys: Object.keys(filter || {}),
        });

        logError(domeError, 'Vector query operation failed');

        metrics.trackOperation('vector_query', false, {
          requestId,
          errorType: domeError.code,
        });

        return {
          error: {
            message: domeError.message,
            code: domeError.code,
            status: domeError.statusCode,
          },
        };
      }
    },
  );
}

export async function stats(this: any) {
  const requestId = crypto.randomUUID();

  return runWithLog(
    {
      service: 'constellation',
      op: 'stats',
      requestId,
      ...this.env,
    },
    async () => {
      try {
        metrics.counter('rpc.stats.requests', 1);

        getLogger().info({ requestId, operation: 'stats' }, 'Fetching vector index statistics');

        const stats = await this.services.vectorize.getStats();

        metrics.counter('rpc.stats.success', 1);

        getLogger().info(
          {
            requestId,
            vectors: stats.vectors,
            dimension: stats.dimension,
            operation: 'stats',
          },
          'Successfully retrieved vector index statistics',
        );

        return stats;
      } catch (error) {
        metrics.counter('rpc.stats.errors', 1);

        const domeError = toDomeError(error, 'Failed to retrieve vector index statistics', {
          requestId,
          operation: 'stats',
        });

        logError(domeError, 'Error getting vector index stats');

        return {
          error: {
            message: domeError.message,
            code: domeError.code,
            status: domeError.statusCode,
          },
        };
      }
    },
  );
}

export async function ping(this: any) {
  const requestId = crypto.randomUUID();
  return runWithLog(
    {
      service: 'constellation',
      op: 'ping',
      requestId,
      ...this.env,
    },
    async () => {
      metrics.counter('rpc.ping.requests', 1);
      getLogger().debug({ requestId, operation: 'ping' }, 'Ping request received');
      return { status: 'ok' };
    },
  );
}
