import { z } from 'zod';
import { ContentCategory, ContentCategoryEnum } from '@dome/common';
import { SearchService, SearchOptions } from "../services/searchService";
import { getLogger } from '@dome/logging';
import { Document, DocumentChunk } from '../types';
import { RetrievalTool, RetrievalInput } from '.';

/* ------------------------------------------------------------------ */
/* Schemas                                                            */
/* ------------------------------------------------------------------ */
export const vectorSearchInput = z.object({
  /** Full-text query string */
  query: z.string(),
  userId: z.string(),
  /** How many items to return (1-20, default 5) */
  topK: z.number().int().nullable(),
});

const DEFAULT_TOP_K = 10;

export const vectorSearchOutput = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    body: z.string(),
    metadata: z.object({
      source: z.string(),
      createdAt: z.string(),
      relevanceScore: z.number(),
      url: z.string().url().nullable().optional(),
      mimeType: z.string().nullable().optional(), // ISO 8601
    })
  }),
);

type RawSearchInput = z.input<typeof vectorSearchInput>;   // topK?: number
type ParsedSearchInput = z.output<typeof vectorSearchInput>;  // topK:  number
type VectorSearchOutput = z.output<typeof vectorSearchOutput>;  // topK:  number

interface VectorRetrievalTool<I = unknown, O = unknown, Raw = I> extends RetrievalTool<I, O, Raw> {
  category: ContentCategory | undefined;
}

/* ------------------------------------------------------------------ */
/* Tool implementation                                                */
/* ------------------------------------------------------------------ */
export const vectorSearchTool: VectorRetrievalTool<
  ParsedSearchInput,
  VectorSearchOutput,
  RawSearchInput
> = {
  name: "vector_search",
  description:
    "Searches the public web and returns the most relevant links with brief snippets.",

  inputSchema: vectorSearchInput,
  outputSchema: vectorSearchOutput,
  category: undefined,

  async retrieve(input: RetrievalInput, env: Env): Promise<VectorSearchOutput> {
    return this.execute({
      query: input.query,
      topK: DEFAULT_TOP_K,
      userId: input.userId,
    }, env);

  },

  async execute(input, env: Env): Promise<VectorSearchOutput> {
    const searchService = SearchService.fromEnv(env);
    const options = buildSearchOptions(input, this.category);
    getLogger().info({ options }, "[VectorSearchTool]: Searching Vectorize");
    let docs = await searchService.search(options);
    docs = SearchService.rankAndFilterDocuments(docs);

    return docs;
  },

  toDocuments(input: VectorSearchOutput): DocumentChunk[] {
    return input.map(r => ({
      id: r.title,
      content: r.body,
      metadata: {
        url: r.metadata.url ?? '',
        createdAt: r.metadata.createdAt,
        relevanceScore: r.metadata.relevanceScore,
        mimeType: r.metadata.mimeType,
        source: r.metadata.source || '',
        sourceType: 'vector',
      }
    }));

  },

  examples: [
    {
      input: { userId: 'test-user', query: "latest GPU trends", topK: 3 },
      output: [],
      description: "Shows news articles about current GPU market trends",
    },
  ],
};

function buildSearchOptions(input: ParsedSearchInput, category?: ContentCategory): SearchOptions {
  const { userId, query, topK } = input;
  return {
    category,
    userId,
    query,
    limit: topK ?? DEFAULT_TOP_K,
    minRelevance: 0.5,
    expandSynonyms: false,
    includeRelated: false,
  };
}

export const docVectorSearchTool: VectorRetrievalTool<
  ParsedSearchInput,
  VectorSearchOutput,
  RawSearchInput
> = {
  ...vectorSearchTool,
  name: "doc_search",
  description: "Searches official documentation, knowledge base articles, structured content",
  category: ContentCategoryEnum.enum.document,
};

export const codeVectorSearchTool: VectorRetrievalTool<
  ParsedSearchInput,
  VectorSearchOutput,
  RawSearchInput
> = {
  ...vectorSearchTool,                  // copy everything
  name: "code_search",
  description: "Searches source code repositories, API documentation, implementation details",
  category: ContentCategoryEnum.enum.code,
};

export const noteVectorSearchTool: VectorRetrievalTool<
  ParsedSearchInput,
  VectorSearchOutput,
  RawSearchInput
> = {
  ...vectorSearchTool,                  // copy everything
  name: "note_search",
  description: "Personal notes, meeting summaries, informal documentation",
  category: ContentCategoryEnum.enum.note,
};
