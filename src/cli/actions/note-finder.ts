import { mastra } from '../../mastra/index.js';
import { join } from 'node:path';
import { z } from 'zod';

// Zod schemas for structured output
const FindExistingNoteSchema = z.object({
  found: z.boolean(),
  path: z.string().optional(),
  reason: z.string().optional()
});

const FindMultipleNotesSchema = z.object({
  results: z.array(z.object({
    path: z.string(),
    title: z.string(),
    relevanceScore: z.number().min(0).max(1),
    excerpt: z.string().optional(),
    reason: z.string().optional()
  })),
  totalFound: z.number()
});

const FindNoteCategorySchema = z.object({
  path: z.string(),
  template: z.string(),
  reasoning: z.string().optional()
});

export type FolderFindResult = z.infer<typeof FindNoteCategorySchema>;
export type MultipleNotesResult = z.infer<typeof FindMultipleNotesSchema>;

export class AINoteFinder {
  async findFolder(topic: string): Promise<FolderFindResult> {
    // Check for OpenAI API key
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY environment variable is not set. Please set it to use AI-powered search.');
    }
    
    let agent;
    try {
      agent = mastra.getAgent('notesAgent');
      if (!agent) {
        throw new Error('Notes agent not available');
      }
    } catch (error) {
      console.error('Failed to initialize notes agent:', error);
      throw new Error(`Notes agent initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    // Use the AI agent to find the best match or suggest a category
    const prompt = `
I'm looking for where to place a note about: "${topic}"
Use the note tools at your disposal to suggest folder path that would be appropriate for this topic.

You must respond with a JSON object that matches this schema:
{
  "path": string,
  "template": string,
  "reasoning": string (optional, explanation of your decision)
}

For "path": provide the relative path to the suggested folder. It can be either an existing directory or if no good match, suggest a new one. The path should end in a forward slash (/) to indicate it's a folder.
For "template": include starter text for the user to begin filling in, in markdown. this may include headings, bullet points, or other markdown elements.

Consider:
- Folder context and readable layout
- Logical directory organization (meetings, projects, journal, inbox, etc.)

Topic: ${topic}
`;

    // Add timeout to prevent hanging
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('AI search timed out after 30 seconds')), 30000);
    });

    const response = await Promise.race([
      agent.generate([
        { role: 'user', content: prompt }
      ], {
        experimental_output: FindNoteCategorySchema
      }),
      timeoutPromise
    ]);

    const result = response.object;

    if (!result) {
      throw new Error('No note or category found');
    }

    // For category type, we need to generate the full file path
    const fileName = this.normalizeTopic(topic);
    return { path: join(result.path, `${fileName}.md`), template: result.template, reasoning: result.reasoning, };
  }

  async findMultipleNotes(topic: string, limit: number = 10): Promise<MultipleNotesResult> {
    try {
      if (process.env.DEBUG) {
        console.log('[AINoteFinder] Starting findMultipleNotes for topic:', topic);
      }
      
      // Check for OpenAI API key
      if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY environment variable is not set. Please set it to use AI-powered search.');
      }
      
      let agent;
      try {
        agent = mastra.getAgent('notesAgent');
        if (!agent) {
          throw new Error('Notes agent not available');
        }
      } catch (error) {
        console.error('Failed to initialize notes agent:', error);
        throw new Error(`Notes agent initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
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

Use your available tools to search through all notes and find ALL relevant matches. Look for:
1. Notes with titles that closely match the search term
2. Notes with content that is relevant to the topic
3. Notes with tags that relate to the topic

For each note found, assign a relevance score from 0 to 1:
- 1.0: Perfect match (title exactly matches or content is highly relevant)
- 0.8-0.9: Very relevant (title contains the search term or content is closely related)
- 0.6-0.7: Relevant (partial title match or moderately related content)
- 0.4-0.5: Somewhat relevant (indirect relation or minor mentions)
- Below 0.4: Not relevant enough to include

Return up to ${limit} most relevant results, sorted by relevance score (highest first).

You must respond with a JSON object that matches this schema:
{
  "results": [
    {
      "path": string (file path),
      "title": string (note title or filename),
      "relevanceScore": number (0-1),
      "excerpt": string (optional, brief excerpt showing relevance),
      "reason": string (optional, why this note is relevant)
    }
  ],
  "totalFound": number (total number of relevant notes found)
}

Search term: ${topic}
`;

      if (process.env.DEBUG) {
        console.log('[AINoteFinder] Sending prompt to agent...');
      }

      const response = await Promise.race([
        agent.generate([
          { role: 'user', content: prompt }
        ], {
          experimental_output: FindMultipleNotesSchema
        }),
        timeoutPromise
      ]);
      
      if (process.env.DEBUG) {
        console.log('[AINoteFinder] Received response from agent');
      }

      const result = response.object;

      if (!result) {
        return { results: [], totalFound: 0 };
      }

      return result;

    } catch (error) {
      console.error('Error finding notes:', error);
      return { results: [], totalFound: 0 };
    }
  }

  async findExistingNote(topic: string): Promise<{ path: string } | null> {
    try {
      // Check for OpenAI API key
      if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY environment variable is not set. Please set it to use AI-powered search.');
      }
      
      let agent;
      try {
        agent = mastra.getAgent('notesAgent');
        if (!agent) {
          throw new Error('Notes agent not available');
        }
      } catch (error) {
        console.error('Failed to initialize notes agent:', error);
        throw new Error(`Notes agent initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }

      // Use the agent to search for existing notes using its tools
      const prompt = `
Search for existing notes that match the topic: "${topic}"

Use your available tools to search through all notes and find the best match. Look for:
1. Notes with titles that closely match the search term
2. Notes with content that is relevant to the topic
3. Notes with tags that relate to the topic

You must respond with a JSON object that matches this schema:
{
  "found": boolean,
  "path": string (optional, only if found is true),
  "reason": string (optional, explanation of why this note was chosen or why none were found)
}

Search term: ${topic}
`;

      // Add timeout to prevent hanging
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('AI search timed out after 30 seconds')), 30000);
      });

      const response = await Promise.race([
        agent.generate([
          { role: 'user', content: prompt }
        ], {
          experimental_output: FindExistingNoteSchema
        }),
        timeoutPromise
      ]);

      const result = response.object;

      if (!result) {
        throw new Error('No note found');
      }

      if (result.found && result.path) {
        return { path: result.path };
      }

      return null;

    } catch (error) {
      throw new Error('No note found');
    }
  }

  private normalizeTopic(topic: string): string {
    return topic
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, '') // Remove special chars except spaces and hyphens
      .replace(/\s+/g, '-') // Replace spaces with hyphens
      .replace(/-+/g, '-') // Collapse multiple hyphens
      .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens
  }
}
