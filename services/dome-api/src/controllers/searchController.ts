import { Context } from 'hono';
import { z } from 'zod';
import { Bindings } from '../types';
import { searchService, PaginatedSearchResults } from '../services/searchService';
import { UserIdContext } from '../middleware/userIdMiddleware';
import { getLogger } from '@dome/logging';
import { ServiceError } from '@dome/common';

/* -------------------------------------------------------------------------- */
/*                             Validation Schema                              */
/* -------------------------------------------------------------------------- */

const SearchQuery = z.object({
  q: z.string().min(1),
  limit: z.coerce.number().int().positive().optional(),
  offset: z.coerce.number().int().min(0).optional(),
  contentType: z.string().optional(),
  startDate: z.coerce.number().int().optional(),
  endDate: z.coerce.number().int().optional(),
  useCache: z.coerce.boolean().optional(),
});

type SearchQueryInput = z.infer<typeof SearchQuery>;

/* -------------------------------------------------------------------------- */
/*                               Util Helpers                                 */
/* -------------------------------------------------------------------------- */

function tooShort(q: string) {
  return q.trim().length < 3;
}

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

function buildParams(userId: string, parsed: SearchQueryInput) {
  const { q, ...rest } = parsed;
  return { userId, query: q, ...rest };
}

/**
 * Format search results for response
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
/*                              Search Controller                              */
/* -------------------------------------------------------------------------- */

export class SearchController {
  /**
   * JSON search endpoint
   */
  static async search(c: Context<{ Bindings: Bindings; Variables: UserIdContext }>): Promise<Response> {
    const log = getLogger();
    try {
      const parsed = SearchQuery.parse(c.req.query()) as SearchQueryInput;
      const userId = c.get('userId');

      if (tooShort(parsed.q)) {
        log.warn({ userId, q: parsed.q }, 'query too short');
        return c.json(emptyResults(parsed.q));
      }

      log.info({ userId, q: parsed.q, params: parsed }, 'search');
      const results = await searchService.search(c.env, buildParams(userId, parsed));
      return c.json(formatSearchResponse(results));
    } catch (error) {
      log.error({ err: error }, 'search error');
      
      if (error instanceof z.ZodError) {
        return c.json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid search parameters',
            details: error.errors,
          }
        }, 400);
      }
      
      if (error instanceof ServiceError) {
        const statusCode = error.status || 500;
        return new Response(
          JSON.stringify({
            success: false,
            error: {
              code: error.code || 'SEARCH_ERROR',
              message: error.message,
            }
          }),
          {
            status: statusCode,
            headers: { 'Content-Type': 'application/json' }
          }
        );
      }
      
      return new Response(
        JSON.stringify({
          success: false,
          error: {
            code: 'SEARCH_ERROR',
            message: error instanceof Error ? error.message : 'An error occurred during search',
          }
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }
  }

  /**
   * NDJSON streaming search endpoint
   */
  static async streamSearch(c: Context<{ Bindings: Bindings; Variables: UserIdContext }>): Promise<Response> {
    const log = getLogger();
    try {
      const parsed = SearchQuery.parse(c.req.query()) as SearchQueryInput;
      const userId = c.get('userId');

      if (tooShort(parsed.q)) {
        log.warn({ userId, q: parsed.q }, 'query too short');
        return c.json(emptyResults(parsed.q));
      }

      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();

      (async () => {
        try {
          const searchResults = await searchService.search(c.env, buildParams(userId, parsed));
          
          // Write metadata first
          await writer.write(
            new TextEncoder().encode(
              JSON.stringify({
                type: 'metadata',
                pagination: searchResults.pagination,
                query: searchResults.query,
              }) + '\n'
            )
          );
          
          // Then stream individual results
          for (const result of searchResults.results) {
            await writer.write(
              new TextEncoder().encode(
                JSON.stringify({
                  type: 'result',
                  data: result,
                }) + '\n'
              )
            );
          }
        } catch (err) {
          log.error({ err }, 'stream search error');
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
          writer.close();
        }
      })();

      return new Response(readable, {
        headers: { 'Content-Type': 'application/x-ndjson' },
      });
    } catch (error) {
      log.error({ err: error }, 'stream search setup error');
      
      if (error instanceof z.ZodError) {
        return new Response(
          JSON.stringify({
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid search parameters',
              details: error.errors,
            }
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          }
        );
      }
      
      return new Response(
        JSON.stringify({
          success: false,
          error: {
            code: 'SEARCH_ERROR',
            message: error instanceof Error ? error.message : 'An error occurred during search setup',
          }
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }
  }
}
