import { z } from 'zod';
import { getLogger } from '@dome/logging';
import { LLMTool } from '.';
/* ------------------------------------------------------------------ */
/* Schemas                                                            */
/* ------------------------------------------------------------------ */
export const webSearchInput = z.object({
  /** Full-text query string */
  query: z.string(),
  /** How many items to return (1-20, default 5) */
  topK: z.number().int().nullable(),
  /** Restrict results to this many recent days (optional) */
  freshDays: z.number().int().nullable().optional(),
});

const DEFAULT_TOP_K = 5;
const DEFAULT_FRESH_DAYS = 365;

export const webSearchOutput = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string().url(),
      snippet: z.string().optional(),
      published: z.string().optional(), // ISO 8601
      source: z.string().optional(),    // domain / provider
    }),
  ),
});

export type RawSearchInput = z.input<typeof webSearchInput>;   // topK?: number
export type ParsedSearchInput = z.output<typeof webSearchInput>;  // topK:  number
export type WebSearchOutput = z.output<typeof webSearchOutput>;  // topK:  number


/* ------------------------------------------------------------------ */
/* Helper that actually hits the search API.                          */
/* Swap this out for your preferred provider.                         */
/* ------------------------------------------------------------------ */
async function fetchBraveSearch(
  q: string,
  k: number,
  freshDays: number | undefined,
  apiKey: string,
) {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", q);
  url.searchParams.set("count", String(k));
  if (freshDays) url.searchParams.set("freshness", `${freshDays}d`);

  const resp = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey,
    },
  });
  if (!resp.ok) throw new Error(`Search API error • ${resp.status}`);

  // TODO: fetch detailed info from the sites
  const json: any = await resp.json();
  return (
    json?.web?.results?.map((r: any) => ({
      title: r.title,
      url: r.url,
      snippet: r.description,
      published: r.published || undefined,
      source: r.source || r.host,
    })) ?? []
  );
}

/* ------------------------------------------------------------------ */
/* Tool implementation                                                */
/* ------------------------------------------------------------------ */
export const webSearchTool: LLMTool<
  ParsedSearchInput,
  WebSearchOutput,
  RawSearchInput
> = {
  name: "web_search",
  description:
    "Searches the public web and returns the most relevant links with brief snippets.",

  inputSchema: webSearchInput,
  outputSchema: webSearchOutput,

  async execute(input, env: Env) {
    const apiKey = env?.SEARCH_API_KEY;
    if (!apiKey) throw new Error("SEARCH_API_KEY is not configured");

    const { query, topK, freshDays } = input;
    getLogger().info({ query, topK, freshDays }, "[webSearchTool]: Searching web");
    // Handle nullable values with sensible defaults
    const effectiveTopK = topK ?? DEFAULT_TOP_K;
    const effectiveFreshDays = freshDays ?? DEFAULT_FRESH_DAYS;

    const results = await fetchBraveSearch(query, effectiveTopK, effectiveFreshDays, apiKey);
    return { results };
  },

  examples: [
    {
      input: { query: "latest GPU trends", topK: 3 },
      output: { results: [] },
      description: "Shows news articles about current GPU market trends",
    },
  ],
};
