import { AINoteFinder } from '../actions/note-finder.js';
import { z } from 'zod';
import { DefaultEditorService } from '../services/editor-service.js';
import { ContextManager } from '../../mastra/core/context/manager.js';
import { writeNote, prepareNoteFolder } from '../../mastra/core/notes.js';
import { mastra } from '../../mastra/index.js';
import { basename } from 'node:path';
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
    const { path, template } = await finder.findFolder(topic);
    const fullPath = await prepareNoteFolder(path);
    const context = await contextManager.getContext(path);

    // Check if file already exists
    let fileExists = false;
    try {
      await fs.access(fullPath);
      fileExists = true;
    } catch {
      // File doesn't exist, which is what we want
    }

    if (fileExists) {
      console.log(`⚠️  Note already exists at: ${path}`);
      console.log('📝 Opening existing note for editing...');
    } else {
      // Write template to file only if it doesn't exist
      console.log(`📝 Creating note with template at: ${path}`);
      await writeNote(path, template, basename(path, '.md'));
    }

    // Open in editor
    const success = await editor.openNote(path, false);

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
