import { mastra } from '../../../mastra/index.js';
import { searchNotesByText } from '../../../mastra/core/search.js';
import { join } from 'node:path';
import { z } from 'zod';
import { promptService, PromptName } from '../../../mastra/prompts/prompt-service.js';
import logger from '../../../mastra/utils/logger.js';

const FindNoteSchema = z.object({
  path: z.string(),
  title: z.string(),
  reason: z.string().optional(),
  relevanceScore: z.number().min(0).max(1),
});

const FindMultipleNotesSchema = z.object({
  notes: z.array(FindNoteSchema),
});

const FindNoteCategorySchema = z.object({
  path: z.string(),
  fileName: z.string(),
  template: z.string(),
  reasoning: z.string().optional(),
});

export type FindNoteResult = z.infer<typeof FindNoteSchema>;
export type FolderFindResult = z.infer<typeof FindNoteCategorySchema>;

/**
 * NoteFinder combines fast local vector search with an optional AI fallback
 * to locate existing notes or suggest the best folder for a new topic.
 */
export class NoteFinder {
  async findPlaceForTopic(topic: string): Promise<FolderFindResult> {
    let agent;
    try {
      agent = mastra.getAgent('notesAgent');
      if (!agent) {
        throw new Error('Notes agent not available');
      }
    } catch (error) {
      logger.error(error, 'Failed to initialize notes agent');
      throw new Error(
        `Notes agent initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }

    // Load prompt template from file and substitute variables
    const prompt = promptService.render(PromptName.NotePlaceForTopic, { topic: topic });

    // Add timeout to prevent hanging
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('AI search timed out after 30 seconds')), 30000);
    });

    const response = await Promise.race([
      agent.generate([{ role: 'user', content: prompt }], {
        experimental_output: FindNoteCategorySchema,
      }),
      timeoutPromise,
    ]);

    const result = response.object;

    if (!result) {
      throw new Error('No note or category found');
    }
    return {
      fileName: result.fileName,
      path: join(result.path, result.fileName),
      template: result.template,
      reasoning: result.reasoning,
    };
  }

  /**
   * Find multiple notes with parallel vector and AI search.
   * Returns immediate vector results and a promise for AI results.
   */
  async findNotes(
    topic: string,
    limit: number = 10
  ): Promise<{
    vectorResults: FindNoteResult[];
    aiResultsPromise: Promise<FindNoteResult[]>;
  }> {
    // Start vector search immediately
    const vectorResultsPromise = this.vectorFindNotes(topic, limit);

    // Start AI search in parallel
    const aiResultsPromise = this.aiFindNotes(topic, limit).catch(error => {
      logger.error(error, 'AI search failed');
      return [];
    });

    return {
      vectorResults: await vectorResultsPromise,
      aiResultsPromise,
    };
  }

  /**
   * Perform AI-powered search (extracted from findNotes)
   */
  private async aiFindNotes(topic: string, limit: number): Promise<FindNoteResult[]> {
    logger.debug(`[NoteFinder] Starting AI search for topic: ${topic}`);

    let agent;
    try {
      agent = mastra.getAgent('notesAgent');
      if (!agent) {
        throw new Error('Notes agent not available');
      }
    } catch (error) {
      logger.error(error, 'Failed to initialize notes agent');
      throw new Error(
        `Notes agent initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }

    logger.debug('[NoteFinder] Agent initialized successfully');

    // Add timeout to prevent hanging
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('AI search timed out after 30 seconds')), 30000);
    });

    const prompt = promptService.render(PromptName.AiSearchNotes, { topic, limit });

    logger.debug('[NoteFinder] Sending prompt to agent...');

    const response = await Promise.race([
      agent.generate([{ role: 'user', content: prompt }], {
        experimental_output: FindMultipleNotesSchema,
      }),
      timeoutPromise,
    ]);

    logger.debug('[NoteFinder] Received response from agent');

    const result = response.object;

    if (!result) {
      return [];
    }

    return result.notes;
  }

  async vectorFindNotes(query: string, limit = 10): Promise<FindNoteResult[]> {
    const results = await searchNotesByText(query, limit * 2);

    const byPath = new Map<string, { path: string; title: string; relevanceScore: number }>();

    for (const r of results) {
      const path = r.metadata?.notePath ?? r.id;
      const score = r.score;
      const title = r.metadata?.text ?? '';
      const existing = byPath.get(path);
      if (!existing || score > existing.relevanceScore) {
        byPath.set(path, { path, title, relevanceScore: score });
      }
    }

    return Array.from(byPath.values())
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, limit);
  }
}

// TEMPORARY BACKWARD-COMPAT: export old name so existing code outside cli still compiles
export const AINoteFinder = NoteFinder;
