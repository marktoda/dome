/**
 * Context-aware search tool
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { searchNotesWithContext } from "../core/context/search-integration.js";

export const contextSearchTool = createTool({
  id: "contextSearch",
  description: "Search notes with context awareness - filter by specific contexts or see context info in results",
  inputSchema: z.object({
    query: z.string().describe("Natural language query to search for in notes"),
    k: z.number().optional().default(6).describe("Number of top results to return"),
    contextPath: z.string().optional().describe("Filter results to this context path (e.g., 'meetings', 'projects/myproject')"),
    includeInheritedContexts: z.boolean().optional().default(true).describe("Include notes from child contexts when filtering")
  }),
  outputSchema: z.array(z.object({
    notePath: z.string(),
    score: z.number(),
    excerpt: z.string(),
    tags: z.array(z.string()).optional(),
    context: z.object({
      name: z.string(),
      path: z.string()
    }).optional()
  })),
  execute: async ({ context }) => {
    try {
      // Check if we have the required environment variable
      if (!process.env.OPENAI_API_KEY) {
        console.error("OPENAI_API_KEY not found, cannot perform semantic search");
        return [];
      }

      const results = await searchNotesWithContext({
        query: context.query,
        k: context.k,
        contextPath: context.contextPath,
        includeInheritedContexts: context.includeInheritedContexts
      });

      return results;
    } catch (error) {
      console.error("Error in context search:", error instanceof Error ? error.message : error);
      return [];
    }
  }
});