import { mastra } from '../../mastra/index.js';
import { listNotes } from '../../mastra/core/notes.js';
import { join } from 'node:path';
import { z } from 'zod';

// Zod schemas for structured output
const FindExistingNoteSchema = z.object({
  found: z.boolean(),
  path: z.string().optional(),
  reason: z.string().optional()
});

const FindNoteCategorySchema = z.object({
  type: z.enum(['note', 'category']),
  path: z.string(),
  reasoning: z.string().optional()
});

export type NoteFindResult = {
  type: 'note',
  path: string,
} | {
  type: 'category',
  path: string,
}

export interface NoteFinder {
  findNoteOrCategory(topic: string): Promise<NoteFindResult>;
  findExistingNote(topic: string): Promise<{ path: string } | null>;
}

export class AINoteFinder implements NoteFinder {
  async findNoteOrCategory(topic: string): Promise<NoteFindResult> {
    try {
      const agent = mastra.getAgent('notesAgent');
      if (!agent) {
        console.warn('Notes agent not available, falling back to basic categorization');
        return { type: 'category', path: this.generateCategoryPath(topic) };
      }

      // Get current notes
      const notes = await listNotes();

      // Create a summary of available notes and directories for the AI
      const notesList = notes.map(n => `- ${n.path}: "${n.title}" (tags: ${n.tags.join(', ') || 'none'})`).join('\n');

      // Get existing directories
      const directories = [...new Set(notes.map(n => n.path.split('/')[0]))].sort();
      const directoriesList = directories.join(', ');

      // Use the AI agent to find the best match or suggest a category
      const prompt = `
I'm looking for where to place a note about: "${topic}"

Here are all existing notes:
${notesList}

Here are existing directories: ${directoriesList}

You must respond with a JSON object that matches this schema:
{
  "type": "note" | "category",
  "path": string,
  "reasoning": string (optional, explanation of your decision)
}

For type "note": provide the exact path to an existing note that would be perfect for appending this topic
For type "category": provide either an existing directory name or suggest a new one

Consider:
- Exact or very similar note titles that would benefit from additional content
- Related topics that belong in the same note (like meeting series, project updates)  
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
        return { type: 'category', path: this.generateCategoryPath(topic) };
      }

      if (result.type === 'note') {
        return { type: 'note', path: result.path };
      } else {
        // For category type, we need to generate the full file path
        const fileName = this.normalizeTopic(topic);
        return { type: 'category', path: join(result.path, `${fileName}.md`) };
      }

      // Fallback if response format is unexpected
      return { type: 'category', path: this.generateCategoryPath(topic) };

    } catch (error) {
      console.warn('AI note finding failed, falling back to basic categorization:', error);
      return { type: 'category', path: this.generateCategoryPath(topic) };
    }
  }

  async findExistingNote(topic: string): Promise<{ path: string } | null> {
    try {
      const agent = mastra.getAgent('notesAgent');
      if (!agent) {
        console.warn('Notes agent not available, falling back to basic search');
        return await this.basicNoteSearch(topic);
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
        return await this.basicNoteSearch(topic);
      }

      if (result.found && result.path) {
        return { path: result.path };
      }

      return null;

    } catch (error) {
      console.warn('AI note search failed, falling back to basic search:', error);
      return await this.basicNoteSearch(topic);
    }
  }

  private async basicNoteSearch(topic: string): Promise<{ path: string } | null> {
    try {
      const notes = await listNotes();
      const searchTerm = topic.toLowerCase();
      
      // Search for exact title match first
      for (const note of notes) {
        if (note.title.toLowerCase() === searchTerm) {
          return { path: note.path };
        }
      }
      
      // Search for partial title match
      for (const note of notes) {
        if (note.title.toLowerCase().includes(searchTerm)) {
          return { path: note.path };
        }
      }
      
      // Search for tag match
      for (const note of notes) {
        if (note.tags.some(tag => tag.toLowerCase().includes(searchTerm))) {
          return { path: note.path };
        }
      }
      
      return null;
    } catch (error) {
      console.warn('Basic note search failed:', error);
      return null;
    }
  }

  private generateCategoryPath(topic: string): string {
    const fileName = this.normalizeTopic(topic);
    return join('inbox', `${fileName}.md`);
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
