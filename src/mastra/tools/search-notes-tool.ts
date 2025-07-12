import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { embed } from "ai";
import { searchSimilarNotes } from "../core/search-indexer.js";

export const searchNotesTool = createTool({
  id: "searchNotes",
  description: "Search notes using semantic similarity based on meaning, not just exact keywords",
  inputSchema: z.object({
    query: z.string().describe("Natural language query to search for in notes"),
    k: z.number().optional().default(6).describe("Number of top results to return")
  }),
  outputSchema: z.array(z.object({
    notePath: z.string(),
    score: z.number(),
    excerpt: z.string(),
    tags: z.array(z.string()).optional()
  })),
  execute: async ({ context }) => {
    try {
      // Generate embedding for the query
      const { embedding } = await embed({
        model: openai.embedding("text-embedding-3-small"),
        value: context.query,
      });

      // Search for similar vectors
      const results = await searchSimilarNotes(embedding, context.k);

      // Transform results to match expected output schema
      return results.map(result => ({
        notePath: result.metadata?.notePath || "",
        score: result.score || 0,
        excerpt: result.metadata?.text || "",
        tags: result.metadata?.tags || []
      }));

    } catch (error) {
      console.error("Error searching notes:", error);
      // Return empty array instead of throwing to allow agent to fall back
      return [];
    }
  }
});