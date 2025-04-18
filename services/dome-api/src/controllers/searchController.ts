import { Context } from 'hono';
import { z } from 'zod';
import { Bindings } from '../types';
import { searchService } from '../services/searchService';
import { UnauthorizedError } from '@dome/common';
import { getLogger } from '@dome/logging';

/* -------------------------------------------------------------------------- */
/*                             Validation Schema                              */
/* -------------------------------------------------------------------------- */

const SearchQuery = z.object({
  q: z.string().min(1),
  limit: z.coerce.number().int().positive().optional(),
  contentType: z.string().optional(),
  startDate: z.coerce.number().int().optional(),
  endDate: z.coerce.number().int().optional(),
});

type SearchQueryInput = z.infer<typeof SearchQuery>;

/* -------------------------------------------------------------------------- */
/*                               Util Helpers                                 */
/* -------------------------------------------------------------------------- */

function getUserId(c: Context): string {
  const id = c.req.header('x-user-id') || c.req.query('userId');
  if (!id) throw new UnauthorizedError('Missing x-user-id header or userId param');
  return id;
}

function tooShort(q: string) {
  return q.trim().length < 3;
}

function emptyResults(q: string) {
  return {
    success: true,
    results: [],
    count: 0,
    query: q,
    message: 'Use at least 3 characters for better results.',
  };
}

function buildParams(userId: string, parsed: SearchQueryInput) {
  const { q, ...rest } = parsed;
  return { userId, query: q, ...rest };
}

/* -------------------------------------------------------------------------- */
/*                              Search Controller                              */
/* -------------------------------------------------------------------------- */

export class SearchController {
  /**
   * JSON search endpoint
   */
  static async search(c: Context<{ Bindings: Bindings }>): Promise<Response> {
    const log = getLogger();
    const parsed = SearchQuery.parse(c.req.query()) as SearchQueryInput;
    const userId = getUserId(c);

    if (tooShort(parsed.q)) {
      log.warn({ userId, q: parsed.q }, 'query too short');
      return c.json(emptyResults(parsed.q));
    }

    log.info({ userId, q: parsed.q }, 'search');
    const results = await searchService.search(c.env, buildParams(userId, parsed));
    return c.json({ success: true, results, count: results.length, query: parsed.q });
  }

  /**
   * NDJSON streaming search endpoint
   */
  static async streamSearch(c: Context<{ Bindings: Bindings }>): Promise<Response> {
    const log = getLogger();
    const parsed = SearchQuery.parse(c.req.query()) as SearchQueryInput;
    const userId = getUserId(c);

    if (tooShort(parsed.q)) {
      log.warn({ userId, q: parsed.q }, 'query too short');
      return c.json(emptyResults(parsed.q));
    }

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    (async () => {
      try {
        const results = await searchService.search(c.env, buildParams(userId, parsed));
        for (const r of results) {
          await writer.write(new TextEncoder().encode(JSON.stringify(r) + '\n'));
        }
      } catch (err) {
        log.error({ err }, 'stream search error');
        await writer.write(
          new TextEncoder().encode(
            JSON.stringify({
              error: {
                code: 'SEARCH_ERROR',
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
  }
}
