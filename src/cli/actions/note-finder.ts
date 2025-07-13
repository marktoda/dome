import { mastra } from '../../mastra/index.js';
import { join } from 'node:path';
import { z } from 'zod';

// Zod schemas for structured output
const FindExistingNoteSchema = z.object({
  found: z.boolean(),
  path: z.string().optional(),
  reason: z.string().optional()
});

const FindNoteCategorySchema = z.object({
  path: z.string(),
  template: z.string(),
  reasoning: z.string().optional()
});

export type FolderFindResult = z.infer<typeof FindNoteCategorySchema>;

export class AINoteFinder {
  async findFolder(topic: string): Promise<FolderFindResult> {
    const agent = mastra.getAgent('notesAgent');
    if (!agent) {
      throw new Error('Notes agent not available');
    }

    // Use the AI agent to find the best match or suggest a category
    const prompt = `
I'm looking for where to place a note about: "${topic}"
Use the note tools at your disposal to suggest a folder.

You must respond with a JSON object that matches this schema:
{
  "path": string,
  "template": string,
  "reasoning": string (optional, explanation of your decision)
}

For "path": provide either an existing directory path, ending in a forward slash (e.g., "meetings/"). If no good match, suggest a new one.
For "template": include starter text for the user to begin filling in, in markdown. this may include headings, bullet points, or other markdown elements.

Consider:
- Folder context and readable layout
- Logical directory organization (meetings, projects, journal, inbox, etc.)

Topic: ${topic}
`;

    const response = await agent.generate([
      { role: 'user', content: prompt }
    ], {
      experimental_output: FindNoteCategorySchema
    });

    const result = response.object;

    if (!result) {
      throw new Error('No note or category found');
    }

    // For category type, we need to generate the full file path
    const fileName = this.normalizeTopic(topic);
    return { path: join(result.path, `${fileName}.md`), template: result.template, reasoning: result.reasoning, };

  }

  async findExistingNote(topic: string): Promise<{ path: string } | null> {
    try {
      const agent = mastra.getAgent('notesAgent');
      if (!agent) {
        throw new Error('Notes agent not available');
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

      const response = await agent.generate([
        { role: 'user', content: prompt }
      ], {
        experimental_output: FindExistingNoteSchema
      });

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
