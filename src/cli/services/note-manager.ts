import { z } from 'zod';
import { getNote, writeNote } from '../../mastra/core/notes.js';
import { ContextManager } from '../../mastra/core/context/manager.js';
import { mastra } from '../../mastra/index.js';
import { DefaultEditorService, EditorService } from './editor-service.js';
import logger from '../../mastra/utils/logger.js';

// Schema for parsing AI cleanup response
const RewriteNoteSchema = z.object({
  noteText: z.string(),
  reasoning: z.string().optional()
});

export class NoteManager {
  private editor: EditorService;
  private contextManager: ContextManager;

  constructor() {
    this.editor = new DefaultEditorService();
    this.contextManager = new ContextManager();
  }

  async editNote(
    topic: string,
    path: string,
  ): Promise<void> {
    const context = await this.contextManager.getContext(path);

    // Open in editor
    const success = await this.editor.openNote(path, false);

    if (!success) {
      logger.error('❌ Error opening note');
      process.exit(1);
    }

    // Read the edited content
    const note = await getNote(path);
    if (!note) {
      logger.error('❌ Error editing note');
      process.exit(1);
    }

    // Review and clean up the note via AI helper
    await this.rewriteNote(topic, context, note.raw, path);
  }

  /**
   * Review and clean up the given note using the `notesAgent`.
   * If the agent is not available, the function simply logs a success message and exits.
   *
   * @param topic       Topic of the note(used to build the prompt)
   * @param context     Folder context information for the note
   * @param editedText  Current(user - edited) note text
   * @param fullPath    Absolute path to the note file on disk
   */
  private async rewriteNote(
    topic: string,
    context: unknown,
    editedText: string,
    path: string
  ): Promise<void> {
    // Get the notes agent for summarization / cleanup
    const agent = mastra.getAgent('notesAgent');
    if (!agent) {
      logger.info('✅ Note saved successfully');
      return;
    }

    logger.info('🤖 Summarizing and cleaning up note...');

    // Build prompt
    const summarizePrompt = `
Please review and improve this note. The note is about: "${topic}"

Context about this folder:
${JSON.stringify(context, null, 2)}

Current note content:
${editedText}

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
      experimental_output: RewriteNoteSchema
    });

    if (response.object?.noteText) {
      const cleanedText = response.object.noteText;
      // Only rewrite the note if the cleaned text is actually different
      if (cleanedText.trim() !== editedText.trim()) {
        await writeNote(path, cleanedText);
        logger.info('✅ Note cleaned up and saved successfully');
      } else {
        logger.info('✅ No cleanup needed – note unchanged');
      }
    } else {
      logger.info('✅ Note saved successfully');
    }
  }
}

