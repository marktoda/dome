import { AINoteFinder } from '../actions/note-finder.js';
import { z } from 'zod';
import { DefaultEditorService } from '../services/editor-service.js';
import { ContextManager } from '../../mastra/core/context/manager.js';
import { writeNote } from '../../mastra/core/notes.js';
import { mastra } from '../../mastra/index.js';
import { join, basename } from 'node:path';
import { config } from '../../mastra/core/config.js';
import fs from 'node:fs/promises';

const CleanupNoteSchema = z.object({
  noteText: z.string(),
  reasoning: z.string().optional()
});

export async function handleNew(topic: string): Promise<void> {
  try {
    const finder = new AINoteFinder();
    const editor = new DefaultEditorService();
    const contextManager = new ContextManager();

    console.log(`🔍 Searching for folders to place "${topic}"...`);

    // Find existing note only
    const result = await finder.findFolder(topic);
    const context = await contextManager.getContext(result.path);

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().split('T')[0];
    const sanitizedTopic = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const filename = `${timestamp}-${sanitizedTopic}.md`;
    const notePath = join(result.path, filename);
    const fullPath = join(config.DOME_VAULT_PATH, notePath);

    // Check if file already exists
    let fileExists = false;
    try {
      await fs.access(fullPath);
      fileExists = true;
    } catch {
      // File doesn't exist, which is what we want
    }

    if (fileExists) {
      console.log(`⚠️  Note already exists at: ${notePath}`);
      console.log('📝 Opening existing note for editing...');
    } else {
      // Write template to file only if it doesn't exist
      console.log(`📝 Creating note with template at: ${notePath}`);
      await writeNote(notePath, result.template, basename(filename, '.md'));
    }

    // Open in editor
    const success = await editor.openNote(notePath, false);

    if (!success) {
      console.error('❌ Error opening note');
      process.exit(1);
    }

    // Read the edited content
    const editedContent = await fs.readFile(fullPath, 'utf8');

    // Get the notes agent for summarization
    const agent = mastra.getAgent('notesAgent');
    if (!agent) {
      console.log('✅ Note saved successfully');
      process.exit(0);
    }

    console.log('🤖 Summarizing and cleaning up note...');

    // Prepare prompt for AI summarization
    const summarizePrompt = `
Please review and improve this note. The note is about: "${topic}"

Context about this folder:
${JSON.stringify(context, null, 2)}

Current note content:
${editedContent}

Please:
1. Clean up and format the content for clarity
2. Add appropriate structure with markdown headings
3. Ensure the content is well-organized
4. Keep all important information but improve readability
5. Maintain the existing frontmatter

Return the complete improved note content including frontmatter.`;

    const response = await agent.generate([
      { role: 'user', content: summarizePrompt }
    ], {
      experimental_output: CleanupNoteSchema
    });

    if (response.object?.noteText) {
      // Write the cleaned up version back to the file
      await fs.writeFile(fullPath, response.object?.noteText, 'utf8');
      console.log('✅ Note created and cleaned up successfully');
    } else {
      console.log('✅ Note saved successfully');
    }
  } catch (error) {
    console.error('❌ Failed to create note:', error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}
