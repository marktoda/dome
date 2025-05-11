import { Context } from 'hono';
import { z } from 'zod';
import { createRoute, OpenAPIHono, RouteConfigToTypedResponse } from '@hono/zod-openapi';
import { AppEnv, Bindings } from '../types';
import { SearchService, PaginatedSearchResults, SearchResult as SearchResultInterface } from '../services/searchService';
import { createServiceFactory } from '../services/serviceFactory'; // Import createServiceFactory
import { trackTiming, trackOperation, incrementCounter, getMetrics } from '../utils/metrics';
import { getLogger, getIdentity, ServiceError } from '@dome/common';
import { AuthContext, authenticationMiddleware } from '../middleware/authenticationMiddleware'; // Correct import for AuthContext and add authenticationMiddleware

// --- OpenAPI Schemas ---

// Error Schema (can be shared or specific)
const SearchErrorDetailSchema = z.object({
  code: z.string().openapi({ example: 'VALIDATION_ERROR' }),
  message: z.string().openapi({ example: 'Invalid search parameters' }),
  details: z.any().optional().openapi({ example: [{ path: ['q'], message: 'Search query is required' }] }),
});
const SearchErrorResponseSchema = z.object({
  success: z.literal(false).openapi({ example: false }),
  error: SearchErrorDetailSchema,
}).openapi('SearchErrorResponse');


// Request Schema (already defined, just for reference here)
// const SearchQuerySchema = z.object({ ... }); // Lines 13-22

// Response Schemas for GET /search
const SearchResultItemSchema = z.object({
  id: z.string().openapi({ example: 'content_id_123' }),
  title: z.string().openapi({ example: 'My Search Result' }),
  summary: z.string().openapi({ example: 'A brief summary of the result.' }),
  body: z.string().optional().openapi({ example: 'The full body content (can be large)...' }), // Optional for list view
  category: z.string().openapi({ example: 'note' }),
  mimeType: z.string().openapi({ example: 'text/markdown' }),
  createdAt: z.number().int().openapi({ example: 1678886400000, description: 'Unix timestamp (milliseconds)' }),
  updatedAt: z.number().int().optional().openapi({ example: 1678886400000, description: 'Unix timestamp (milliseconds)' }), // Make optional if not always present
  score: z.number().openapi({ example: 0.85 }),
}).openapi('SearchResultItem');

const PaginationSchema = z.object({
  total: z.number().int().openapi({ example: 100 }),
  limit: z.number().int().openapi({ example: 10 }),
  offset: z.number().int().openapi({ example: 0 }),
  hasMore: z.boolean().openapi({ example: true }),
}).openapi('Pagination');

const SearchResponseDataSchema = z.object({
  success: z.literal(true).openapi({ example: true }),
  results: z.array(SearchResultItemSchema),
  pagination: PaginationSchema,
  query: z.string().openapi({ example: 'test query' }),
  message: z.string().optional().openapi({ example: 'Use at least 3 characters for better results.' }),
}).openapi('SearchResponse');

// Response Schemas for GET /search/stream (NDJSON)
const StreamingMetadataSchema = z.object({
  type: z.literal('metadata'),
  pagination: PaginationSchema,
  query: z.string(),
}).openapi('StreamingMetadata');

const StreamingResultDataSchema = z.object({
  type: z.literal('result'),
  data: SearchResultItemSchema,
}).openapi('StreamingResultData');

const StreamingErrorDataSchema = z.object({
  type: z.literal('error'),
  error: z.object({
    code: z.string().openapi({ example: 'SEARCH_ERROR' }),
    message: z.string().openapi({ example: 'An error occurred during streaming.' }),
  }),
}).openapi('StreamingErrorData');

const StreamingSearchEventSchema = z.union([
  StreamingMetadataSchema,
  StreamingResultDataSchema,
  StreamingErrorDataSchema,
]).openapi('StreamingSearchEvent');


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
    success: true as const, // Ensure success is literal true
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
    success: true as const, // Ensure success is literal true
    results: results.results,
    pagination: results.pagination,
    query: results.query,
  };
}

/* -------------------------------------------------------------------------- */
/*                              Search Controller                             */
/* -------------------------------------------------------------------------- */

// --- Route Definitions ---
const searchRoute = createRoute({
  method: 'get',
  path: '/',
  summary: 'Search Content',
  description: 'Performs a paginated search over indexed content.',
  security: [{ BearerAuth: [] }],
  request: {
    query: SearchQuerySchema, // Existing Zod schema for query params
  },
  responses: {
    200: {
      description: 'Successful search results.',
      content: { 'application/json': { schema: SearchResponseDataSchema } },
    },
    400: {
      description: 'Bad Request (e.g., validation error).',
      content: { 'application/json': { schema: SearchErrorResponseSchema } },
    },
    401: {
      description: 'Unauthorized.',
      content: { 'application/json': { schema: SearchErrorResponseSchema } },
    },
    500: {
      description: 'Internal Server Error.',
      content: { 'application/json': { schema: SearchErrorResponseSchema } },
    },
  },
  tags: ['Search'],
});

const streamSearchRoute = createRoute({
  method: 'get',
  path: '/stream',
  summary: 'Stream Search Content (NDJSON)',
  description: 'Performs a search and streams results as NDJSON events.',
  security: [{ BearerAuth: [] }],
  request: {
    query: SearchQuerySchema,
  },
  responses: {
    200: {
      description: 'Stream of search events (metadata, results, errors) in NDJSON format.',
      content: {
        'application/x-ndjson': {
          // OpenAPI spec for NDJSON is tricky. We describe the events.
          // The actual response is a stream of JSON objects, each on a new line.
          schema: StreamingSearchEventSchema, // Describes one possible event in the stream
        }
      }
    },
    400: {
      description: 'Bad Request (e.g., validation error).',
      content: { 'application/json': { schema: SearchErrorResponseSchema } }, // Error before stream starts
    },
    401: {
      description: 'Unauthorized.',
      content: { 'application/json': { schema: SearchErrorResponseSchema } },
    },
    500: {
      description: 'Internal Server Error.',
      content: { 'application/json': { schema: SearchErrorResponseSchema } },
    },
  },
  tags: ['Search'],
});

/* -------------------------------------------------------------------------- */
/*                              Search Controller                             */
/* -------------------------------------------------------------------------- */

export class SearchController {
  private logger;
  // searchService will be obtained per-request or via a getter

  constructor() {
    this.logger = getLogger().child({ component: 'SearchController' });
    // No service in constructor
  }

  private getSearchService(env: Bindings): SearchService {
    // This assumes createServiceFactory() is lightweight or we have a shared factory instance.
    // For consistency with other new controllers, they create a factory or use a global one.
    // Here, we'll create one. If performance becomes an issue, a shared factory could be injected.
    const serviceFactory = createServiceFactory(); // Re-evaluate if this should be a member or passed
    const constellationClient = serviceFactory.getConstellationService(env);
    const siloClient = serviceFactory.getSiloService(env);
    return new SearchService(constellationClient, siloClient);
  }

  /**
   * JSON search endpoint for all content types
   * @param c Hono context
   * @param params Validated query parameters
   * @returns Response with search results
   */
  async search(
    c: Context<AppEnv & { Variables: { auth: AuthContext } }>,
    params: z.infer<typeof SearchQuerySchema>
  ): Promise<RouteConfigToTypedResponse<typeof searchRoute>> {
    try {
      const userId = c.get('auth').userId;
      const parsed = params; // Use validated params

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
        return c.json(emptyResults(parsed.q), 200); // Matches SearchResponseDataSchema
      }

      this.logger.info({ userId, q: parsed.q, params: parsed }, 'search query');

      // Track search operation with timing
      const results = await trackTiming('search.execution', {
        query_length: parsed.q.length.toString(),
        has_filters:
          parsed.category || parsed.mimeType || parsed.startDate || parsed.endDate
            ? 'true'
            : 'false',
      })(async () => {
        const searchService = this.getSearchService(c.env);
        return await searchService.search(c.env, buildParams(userId, parsed));
      });

      // Track result count
      incrementCounter('search.results', results.results.length, {
        has_results: results.results.length > 0 ? 'true' : 'false',
      });

      this.logger.info({ userId, q: parsed.q, results }, 'search results');
      return c.json(formatSearchResponse(results), 200); // Matches SearchResponseDataSchema
    } catch (error) {
      this.logger.error({ err: error }, 'search error');

      // Track search error with metrics
      incrementCounter('search.error', 1, {
        error_type: error instanceof Error ? error.name : 'unknown',
      });

      if (error instanceof z.ZodError) { // Should ideally be caught by Hono's OpenAPI validation if c.req.valid is used
        incrementCounter('search.validation_error', 1);
        return c.json(
          {
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid search parameters',
              details: error.errors as any, // Ensure details match schema if possible
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
        const errorPayload = {
            success: false as const,
            error: {
              code: error.code || 'SEARCH_ERROR',
              message: error.message,
            },
          };
        if (statusCode === 400) return c.json(errorPayload, 400);
        if (statusCode === 401) return c.json(errorPayload, 401);
        // Default to 500 or map other specific service error statuses
        return c.json(errorPayload, 500);
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
   * @param params Validated query parameters
   * @returns Streaming response with search results
   */
  async streamSearch(
    c: Context<AppEnv & { Variables: { auth: AuthContext } }>,
    params: z.infer<typeof SearchQuerySchema>
  ): Promise<Response> { // Return type remains Promise<Response> for direct stream handling
    try {
      const userId = c.get('auth').userId;
      const parsed = params; // Use validated params

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
        // This error occurs before the stream starts, so a JSON error response is appropriate.
        return c.json(
          {
            success: false,
            error: {
              code: 'QUERY_TOO_SHORT',
              message: 'Search query is too short. Use at least 3 characters for better results.',
              // details: emptyResults(parsed.q) // Optionally include for context
            },
          },
          400
        );
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
          const searchService = this.getSearchService(c.env);
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

      if (error instanceof z.ZodError) { // Should be caught by Hono if c.req.valid('query') is used
        incrementCounter('search.stream_validation_error', 1);
        return c.json(
          {
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid search parameters',
              details: error.errors as any,
            },
          },
          400,
        );
      }

      incrementCounter('search.stream_unexpected_error', 1);
      // This error is before stream starts.
      return c.json(
        {
          success: false,
          error: {
            code: 'SEARCH_SETUP_ERROR',
            message:
              error instanceof Error ? error.message : 'An error occurred during search setup',
          },
        },
        500,
      );
    }
  }
}

export function buildSearchRouter(): OpenAPIHono<AppEnv & { Variables: { auth: AuthContext } }> {
  const router = new OpenAPIHono<AppEnv & { Variables: { auth: AuthContext } }>();
  const searchController = new SearchController(); // Create instance here

  // Apply authentication middleware to all routes in this router
  router.use('*', authenticationMiddleware);

  router.openapi(searchRoute, (c) => {
    const validatedParams = c.req.valid('query');
    return searchController.search(c, validatedParams);
  });

  router.openapi(streamSearchRoute, (c) => {
    const validatedParams = c.req.valid('query');
    // Cast to `any` for stream response to satisfy openapi wrapper, as it expects typed JSON.
    // The actual response is a correctly formatted NDJSON stream.
    return searchController.streamSearch(c, validatedParams) as any;
  });

  return router;
}

