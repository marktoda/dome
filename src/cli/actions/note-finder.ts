import { mastra } from '../../mastra/index.js';
import { listNotes } from '../../mastra/core/notes.js';
import { join } from 'node:path';

export type NoteFindResult = {
  type: 'note',
  path: string,
} | {
  type: 'category',
  path: string,
}

export interface NoteFinder {
  findNoteOrCategory(topic: string): Promise<NoteFindResult>;
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

Please help me decide:
1. If there's an existing note that would be perfect for appending this topic, respond with: "NOTE: path/to/note.md"
2. If no exact note match but there's a good directory category, respond with: "CATEGORY: directory-name"
3. If you need to suggest a new directory category, respond with: "CATEGORY: new-category-name"

Consider:
- Exact or very similar note titles that would benefit from additional content
- Related topics that belong in the same note (like meeting series, project updates)
- Logical directory organization (meetings, projects, journal, inbox, etc.)

Topic: ${topic}
`;

      const response = await agent.generate([
        { role: 'user', content: prompt }
      ]);

      const result = response.text?.trim();

      if (!result) {
        return { type: 'category', path: this.generateCategoryPath(topic) };
      }

      // Parse the response
      if (result.startsWith('NOTE: ')) {
        const notePath = result.replace('NOTE: ', '').trim();
        return { type: 'note', path: notePath };
      } else if (result.startsWith('CATEGORY: ')) {
        const category = result.replace('CATEGORY: ', '').trim();
        const fileName = this.normalizeTopic(topic);
        return { type: 'category', path: join(category, `${fileName}.md`) };
      }

      // Fallback if response format is unexpected
      return { type: 'category', path: this.generateCategoryPath(topic) };

    } catch (error) {
      console.warn('AI note finding failed, falling back to basic categorization:', error);
      return { type: 'category', path: this.generateCategoryPath(topic) };
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
