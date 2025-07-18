import { mastra } from '../../mastra/index.js';
import { searchNotesByText } from '../../mastra/core/search.js';
import { join } from 'node:path';
import { z } from 'zod';

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

export class AINoteFinder {
  async findPlaceForTopic(topic: string): Promise<FolderFindResult> {
    // Check for OpenAI API key
    if (!process.env.OPENAI_API_KEY) {
      throw new Error(
        'OPENAI_API_KEY environment variable is not set. Please set it to use AI-powered search.'
      );
    }

    let agent;
    try {
      agent = mastra.getAgent('notesAgent');
      if (!agent) {
        throw new Error('Notes agent not available');
      }
    } catch (error) {
      console.error('Failed to initialize notes agent:', error);
      throw new Error(
        `Notes agent initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }

    // Use the AI agent to find the best match or suggest a category
    const prompt = `
You are ** Notes Agent ** in read‑only mode.

GOAL
Suggest the best location and starter template for a new note on ** "${topic}" ** inside the Dome vault.

WORKFLOW
1. Call ** getVaultContextTool ** to load the current directory tree.
2. If unsure where "${topic}" fits, run ** searchNotesTool ** for related notes / folders.
3. Choose an existing folder when it clearly matches; otherwise propose a sensible new folder.

GUIDELINES
• Keep folder structure logical(e.g.meetings /, projects /, journal /, inbox /).
• Use kebab‑case for filenames; always include “.md”.
• The template may include headings, checklists, or bullet points to help the user start writing.
• Do ** not ** create, edit, or delete any notes—this is a planning step only.`

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
      path: join(result.path, `${result.fileName} `),
      template: result.template,
      reasoning: result.reasoning,
    };
  }

  /**
   * Find multiple notes with parallel vector and AI search
   * Returns immediate vector results and a promise for AI results
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
      console.error('AI search failed:', error);
      return [];
    });

    return {
      vectorResults: await vectorResultsPromise,
      aiResultsPromise,
    };
  }

  /**
   * Perform AI-powered search (extracted from findMultipleNotes)
   */
  private async aiFindNotes(topic: string, limit: number): Promise<FindNoteResult[]> {
    if (process.env.DEBUG) {
      console.log('[AINoteFinder] Starting AI search for topic:', topic);
    }

    // Check for OpenAI API key
    if (!process.env.OPENAI_API_KEY) {
      throw new Error(
        'OPENAI_API_KEY environment variable is not set. Please set it to use AI-powered search.'
      );
    }

    let agent;
    try {
      agent = mastra.getAgent('notesAgent');
      if (!agent) {
        throw new Error('Notes agent not available');
      }
    } catch (error) {
      console.error('Failed to initialize notes agent:', error);
      throw new Error(
        `Notes agent initialization failed: ${error instanceof Error ? error.message : 'Unknown error'} `
      );
    }

    if (process.env.DEBUG) {
      console.log('[AINoteFinder] Agent initialized successfully');
    }

    // Add timeout to prevent hanging
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('AI search timed out after 30 seconds')), 30000);
    });

    const prompt = `
Search for existing notes that match the topic: "${topic}"

Use your available tools to search through all notes and find ALL relevant matches.Look for:
      1. Notes with titles that closely match the search term
    2. Notes with content that is relevant to the topic
    3. Notes with tags that relate to the topic

For each note found, assign a relevance score from 0 to 1:
    - 1.0: Perfect match(title exactly matches or content is highly relevant)
      - 0.8 - 0.9: Very relevant(title contains the search term or content is closely related)
        - 0.6 - 0.7: Relevant(partial title match or moderately related content)
          - 0.4 - 0.5: Somewhat relevant(indirect relation or minor mentions)
            - Below 0.4: Not relevant enough to include

Return up to ${limit} most relevant results, sorted by relevance score(highest first).Be sure to use the getVaultContext tool to get a full view of the vault structure.
`;

    if (process.env.DEBUG) {
      console.log('[AINoteFinder] Sending prompt to agent...');
    }

    const response = await Promise.race([
      agent.generate([{ role: 'user', content: prompt }], {
        experimental_output: FindMultipleNotesSchema,
      }),
      timeoutPromise,
    ]);

    if (process.env.DEBUG) {
      console.log('[AINoteFinder] Received response from agent');
    }

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
