import { z } from 'zod';
import { noteStore, NoteId } from '../../mastra/core/note-store.js';
import { getNote } from '../../mastra/core/notes.js';
import { ContextManager } from '../../mastra/core/context/manager.js';
import { mastra } from '../../mastra/index.js';
import { editorManager } from './editor-manager.js';
import logger from '../../mastra/utils/logger.js';
import { toRel } from '../../mastra/utils/path-utils.js';
import { join } from 'node:path';

// Schema for parsing AI cleanup response
const RewriteNoteSchema = z.object({
  noteText: z.string().describe('the full improved note, including unchanged front‑matter'),
  suggestedNoteFilename: z.string().describe('e.g. topic-key-points.md'),
  reasoning: z.string().optional().describe('brief rationale for major changes (optional)'),
});

export class NoteManager {
  private contextManager: ContextManager;

  constructor() {
    this.contextManager = new ContextManager();
  }

  async editNote(topic: string, originalPath: string): Promise<void> {
    // Ensure we operate on a vault-relative path.
    const relPath: NoteId = toRel(originalPath);
    // Capture the original content before opening the editor so we can
    // determine whether the user actually made any changes.
    const originalNote = await getNote(relPath);
    if (!originalNote) {
      logger.error('❌ Error reading note before edit');
      process.exit(1);
    }

    const context = await this.contextManager.getContext(relPath);

    // Open in editor using the new EditorManager
    const success = await editorManager.openEditor({
      path: relPath,
      isNew: false,
      onOpen: () => {
        logger.debug(`Opening note: ${relPath}`);
      },
      onClose: (success) => {
        logger.debug(`Editor closed with success: ${success}`);
      },
      onError: (error) => {
        logger.error(`Editor error: ${error.message}`);
      },
    });

    if (!success) {
      logger.error('❌ Error opening note');
      process.exit(1);
    }

    // Read the content after the editor session
    const editedNote = await getNote(relPath);
    if (!editedNote) {
      logger.error('❌ Error reading note after edit');
      process.exit(1);
    }

    // If the user didn't modify the note, skip any cleanup / rewrite step
    if (editedNote.raw.trim() === originalNote.raw.trim()) {
      logger.info('✅ No changes detected – note left unchanged');
      return;
    }

    // Review and clean up the note via AI helper
    await this.rewriteNote(topic, context, editedNote.raw, relPath);
  }

  /**
   * Analyse arbitrary note content and let the AI suggest
   * a suitable topic/title and destination folder+filename.
   * Returns the chosen topic and the vault-relative path
   * (including the filename) where the note should live.
   */
  async autoCategorize(noteContent: string): Promise<{ topic: string; path: string }> {
    // Zod schema for the AI response
    const CategorizeSchema = z.object({
      title: z.string().min(1).describe('A concise title for the note'),
      folderPath: z
        .string()
        .min(1)
        .describe("Relative vault folder ending with '/' e.g. 'projects/'"),
      fileName: z.string().min(1).describe('File name including .md extension'),
      reasoning: z.string().optional(),
    });

    // Ensure AI features are enabled
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY not set – cannot categorise quick note');
    }

    const agent = mastra.getAgent('notesAgent');
    if (!agent) {
      throw new Error('notesAgent not registered in Mastra – cannot categorise quick note');
    }

    const prompt = /* md */ `
You are **Notes Agent**.

GOAL
Analyse the Markdown note below and propose the most suitable vault location and filename.

WORKFLOW
1. Run **getVaultContextTool** to load the current folder structure.
2. If helpful, run **searchNotesTool** to see where similar notes live.
3. Pick the best existing folder; create a sensible new folder only if nothing fits.

GUIDELINES
• Keep folder organisation logical (projects/, meetings/, journal/, inbox/, etc.).
• Use kebab‑case filenames with the .md extension.
• Do **not** write, edit, or delete any notes—classification only.

NOTE CONTENT START
${noteContent.trim().slice(0, 4000)}
NOTE CONTENT END
`;

    const response = await agent.generate([{ role: 'user', content: prompt }], {
      experimental_output: CategorizeSchema,
    });

    const obj = response.object;
    if (!obj) {
      throw new Error('AI categorisation failed – no response object');
    }

    const fullRelPath = join(obj.folderPath, obj.fileName);

    return {
      topic: obj.title,
      path: fullRelPath,
    };
  }

  /**
   * Run the AI clean-up pass on an existing note **without** opening the editor.
   * Useful after quick-note capture where the file is already written.
   */
  async cleanupNote(topic: string, relPath: NoteId): Promise<void> {
    // Load the current content
    const note = await getNote(relPath);
    if (!note) {
      logger.warn(`Note ${relPath} not found – skipping cleanup`);
      return;
    }

    const context = await this.contextManager.getContext(relPath);

    await this.rewriteNote(topic, context, note.raw, relPath);
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
    path: NoteId
  ): Promise<void> {
    // Get the notes agent for summarization / cleanup
    const agent = mastra.getAgent('readNotesAgent');
    if (!agent) {
      logger.info('✅ Note saved successfully');
      return;
    }

    logger.info('🤖 Summarizing and cleaning up note...');

    const rewritePrompt = /* md */ `
You are **Notes Agent**.
Goal → Rewrite the note below for clarity and structure while **preserving every important fact** and the existing YAML front‑matter.

INPUTS
• **Topic**: "${topic}"
• **Vault‑folder context (JSON)**:
${JSON.stringify(context, null, 2)}

• **Current note markdown**:
${editedText}

TASKS
1. Re‑organize and clean the prose for readability.
2. Add logical Markdown headings / lists where helpful.
3. Keep the original front‑matter unchanged and at the top.
4. DO NOT remove or truncate information unless explicitly instructed.
5. Propose a succinct, kebab‑case filename that matches the note’s content and folder context.
5. Try to adhere to the structure and template from the context file, without messing up the file content

Respond **with nothing else** — only the valid JSON.`


    const response = await agent.generate([{ role: 'user', content: rewritePrompt }], {
      experimental_output: RewriteNoteSchema,
    });

    if (response.object?.noteText) {
      const cleanedText = response.object.noteText;
      // Only rewrite the note if the cleaned text is actually different
      if (cleanedText.trim() !== editedText.trim()) {
        await noteStore.store(path, cleanedText);
        logger.info(`✅ Note cleaned up and saved successfully: ${response.object.reasoning}`);
      } else {
        logger.info('✅ No cleanup needed – note unchanged');
      }
    } else {
      logger.info('✅ Note saved successfully');
    }
  }
}
