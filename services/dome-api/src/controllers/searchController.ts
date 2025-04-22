import { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { Bindings } from '../types';
import { searchService, PaginatedSearchResults } from '../services/searchService';
import { trackTiming, trackOperation, incrementCounter, getMetrics } from '../utils/metrics';
import { UserIdContext } from '../middleware/userIdMiddleware';
import { getLogger } from '@dome/logging';
import { ServiceError } from '@dome/common';

/* -------------------------------------------------------------------------- */
/*                             Validation Schema                              */
/* -------------------------------------------------------------------------- */

const SearchQuerySchema = z.object({
  q: z.string().min(1, 'Search query is required'),
  limit: z.coerce.number().int().positive().optional().default(10),
  offset: z.coerce.number().int().min(0).optional().default(0),
  category: z.string().optional(),
  mimeType: z.string().optional(),
  startDate: z.coerce.number().int().optional(),
  endDate: z.coerce.number().int().optional(),
  useCache: z.coerce.boolean().optional().default(true),
});

export type SearchQueryInput = z.infer<typeof SearchQuerySchema>;

/* -------------------------------------------------------------------------- */
/*                               Util Helpers                                 */
/* -------------------------------------------------------------------------- */

/**
 * Check if search query is too short
 * @param q Search query
 * @returns True if query is too short
 */
function tooShort(q: string): boolean {
  return q.trim().length < 3;
}

/**
 * Generate empty results response
 * @param q Search query
 * @returns Empty results response
 */
function emptyResults(q: string) {
  return {
    success: true,
    results: [],
    pagination: {
      total: 0,
      limit: 10,
      offset: 0,
      hasMore: false,
    },
    query: q,
    message: 'Use at least 3 characters for better results.',
  };
}

/**
 * Build search parameters from parsed input
 * @param userId User ID
 * @param parsed Parsed search query input
 * @returns Search parameters
 */
function buildParams(userId: string, parsed: SearchQueryInput) {
  const { q, ...rest } = parsed;
  return { userId, query: q, ...rest };
}

/**
 * Format search results for response
 * @param results Paginated search results
 * @returns Formatted search response
 */
function formatSearchResponse(results: PaginatedSearchResults) {
  return {
    success: true,
    results: results.results,
    pagination: results.pagination,
    query: results.query,
  };
}

/* -------------------------------------------------------------------------- */
/*                              Search Controller                             */
/* -------------------------------------------------------------------------- */

export class SearchController {
  private logger = getLogger();

  /**
   * JSON search endpoint for all content types
   * @param c Hono context
   * @returns Response with search results
   */
  async search(c: Context<{ Bindings: Bindings; Variables: UserIdContext }>): Promise<Response> {
    try {
      const parsed = SearchQuerySchema.parse(c.req.query());
      const userId = c.get('userId');

      // Track search query metrics
      incrementCounter('search.query', 1, {
        query_length: parsed.q.length.toString(),
        has_filters:
          parsed.category || parsed.mimeType || parsed.startDate || parsed.endDate
            ? 'true'
            : 'false',
      });

      if (tooShort(parsed.q)) {
        this.logger.warn({ userId, q: parsed.q }, 'query too short');
        incrementCounter('search.query_too_short', 1);
        return c.json(emptyResults(parsed.q));
      }

      this.logger.info({ userId, q: parsed.q, params: parsed }, 'search');

      // Track search operation with timing
      const results = await trackTiming('search.execution', {
        query_length: parsed.q.length.toString(),
        has_filters:
          parsed.category || parsed.mimeType || parsed.startDate || parsed.endDate
            ? 'true'
            : 'false',
      })(async () => {
        return await searchService.search(c.env, buildParams(userId, parsed));
      });

      // Track result count
      incrementCounter('search.results', results.results.length, {
        has_results: results.results.length > 0 ? 'true' : 'false',
      });

      this.logger.info({ userId, q: parsed.q, results }, 'search results');
      return c.json(formatSearchResponse(results));
    } catch (error) {
      this.logger.error({ err: error }, 'search error');

      // Track search error with metrics
      incrementCounter('search.error', 1, {
        error_type: error instanceof Error ? error.name : 'unknown',
      });

      if (error instanceof z.ZodError) {
        incrementCounter('search.validation_error', 1);
        return c.json(
          {
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid search parameters',
              details: error.errors,
            },
          },
          400,
        );
      }

      if (error instanceof ServiceError) {
        const statusCode = error.status || 500;
        incrementCounter('search.service_error', 1, {
          code: error.code || 'UNKNOWN',
          status: statusCode.toString(),
        });
        return c.json(
          {
            success: false,
            error: {
              code: error.code || 'SEARCH_ERROR',
              message: error.message,
            },
          },
          statusCode as any,
        );
      }

      incrementCounter('search.unexpected_error', 1);
      return c.json(
        {
          success: false,
          error: {
            code: 'SEARCH_ERROR',
            message: error instanceof Error ? error.message : 'An error occurred during search',
          },
        },
        500,
      );
    }
  }

  /**
   * NDJSON streaming search endpoint for all content types
   * @param c Hono context
   * @returns Streaming response with search results
   */
  async streamSearch(
    c: Context<{ Bindings: Bindings; Variables: UserIdContext }>,
  ): Promise<Response> {
    try {
      const parsed = SearchQuerySchema.parse(c.req.query());
      const userId = c.get('userId');

      // Track streaming search query metrics
      incrementCounter('search.stream_query', 1, {
        query_length: parsed.q.length.toString(),
        has_filters:
          parsed.category || parsed.mimeType || parsed.startDate || parsed.endDate
            ? 'true'
            : 'false',
      });

      if (tooShort(parsed.q)) {
        this.logger.warn({ userId, q: parsed.q }, 'query too short');
        incrementCounter('search.stream_query_too_short', 1);
        return c.json(emptyResults(parsed.q));
      }

      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();

      (async () => {
        // Start a timer for the streaming search
        const timer = getMetrics().startTimer('search.stream_execution', {
          query_length: parsed.q.length.toString(),
          has_filters:
            parsed.category || parsed.mimeType || parsed.startDate || parsed.endDate
              ? 'true'
              : 'false',
        });

        try {
          const searchResults = await searchService.search(c.env, buildParams(userId, parsed));

          // Track result count
          incrementCounter('search.stream_results', searchResults.results.length, {
            has_results: searchResults.results.length > 0 ? 'true' : 'false',
          });

          // Write metadata first
          await writer.write(
            new TextEncoder().encode(
              JSON.stringify({
                type: 'metadata',
                pagination: searchResults.pagination,
                query: searchResults.query,
              }) + '\n',
            ),
          );

          // Then stream individual results
          for (const result of searchResults.results) {
            await writer.write(
              new TextEncoder().encode(
                JSON.stringify({
                  type: 'result',
                  data: result,
                }) + '\n',
              ),
            );
          }
        } catch (err) {
          this.logger.error({ err }, 'stream search error');

          // Track search error
          incrementCounter('search.stream_error', 1, {
            error_type: err instanceof Error ? err.name : 'unknown',
          });

          await writer.write(
            new TextEncoder().encode(
              JSON.stringify({
                type: 'error',
                error: {
                  code: err instanceof ServiceError ? err.code : 'SEARCH_ERROR',
                  message: err instanceof Error ? err.message : 'unknown',
                },
              }) + '\n',
            ),
          );
        } finally {
          // Stop the timer in finally block to ensure it's always recorded
          timer.stop({
            success: 'false',
            error: 'true',
          });
          writer.close();
        }
      })();

      return new Response(readable, {
        headers: { 'Content-Type': 'application/x-ndjson' },
      });
    } catch (error) {
      this.logger.error({ err: error }, 'stream search setup error');

      // Track stream search setup error with metrics
      incrementCounter('search.stream_setup_error', 1, {
        error_type: error instanceof Error ? error.name : 'unknown',
      });

      if (error instanceof z.ZodError) {
        incrementCounter('search.stream_validation_error', 1);
        return c.json(
          {
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid search parameters',
              details: error.errors,
            },
          },
          400,
        );
      }

      incrementCounter('search.stream_unexpected_error', 1);
      return c.json(
        {
          success: false,
          error: {
            code: 'SEARCH_ERROR',
            message:
              error instanceof Error ? error.message : 'An error occurred during search setup',
          },
        },
        500,
      );
    }
  }
}

// Export singleton instance
export const searchController = new SearchController();
