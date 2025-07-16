import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { openai } from '@ai-sdk/openai';
import { embed } from 'ai';
import { searchSimilarNotes } from '../core/search.js';

export const searchNotesTool = createTool({
  id: 'searchNotes',
  description: 'Search notes using semantic similarity based on meaning, not just exact keywords',
  inputSchema: z.object({
    query: z.string().describe('Natural language query to search for in notes'),
    k: z.number().optional().default(6).describe('Number of top results to return'),
  }),
  outputSchema: z.array(
    z.object({
      notePath: z.string(),
      score: z.number(),
      excerpt: z.string(),
      tags: z.array(z.string()).optional(),
    })
  ),
  execute: async ({ context }) => {
    try {
      // Check if we have the required environment variable
      if (!process.env.OPENAI_API_KEY) {
        console.error('OPENAI_API_KEY not found, cannot perform semantic search');
        return [];
      }

      // Generate embedding for the query
      const { embedding } = await embed({
        model: openai.embedding('text-embedding-3-small'),
        value: context.query,
      });

      // Search for similar vectors
      const results = await searchSimilarNotes(embedding, context.k);

      // Ensure results is an array and handle potential undefined values
      if (!Array.isArray(results)) {
        console.error('Search returned non-array result:', results);
        return [];
      }

      // Transform results to match expected output schema
      return results.map(result => ({
        notePath: result.metadata?.notePath || '',
        score: result.score || 0,
        excerpt: result.metadata?.text || '',
        tags: Array.isArray(result.metadata?.tags) ? result.metadata.tags : [],
      }));
    } catch (error) {
      console.error('Error searching notes:', error instanceof Error ? error.message : error);
      // Return empty array instead of throwing to allow agent to fall back
      return [];
    }
  },
});
