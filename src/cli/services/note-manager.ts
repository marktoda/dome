import { z } from 'zod';
import { NoteService, NoteId } from '../../core/services/NoteService.js';
import { mastra } from '../../mastra/index.js';
import { promptService, PromptName } from '../../mastra/prompts/prompt-service.js';
import { editorManager } from './editor-manager.js';
import logger from '../../core/utils/logger.js';
import { toRel } from '../../core/utils/path-utils.js';
import { join } from 'node:path';

export class NoteManager {
  private noteService: NoteService;

  constructor() {
    this.noteService = new NoteService();
  }

  async editNote(topic: string, originalPath: string): Promise<void> {
    // Ensure we operate on a vault-relative path.
    const relPath: NoteId = toRel(originalPath);
    // Capture the original content before opening the editor so we can
    // determine whether the user actually made any changes.
    const originalNote = await this.noteService.getNote(relPath);
    if (!originalNote) {
      throw new Error('Error reading note before edit');
    }

    // Open in editor using the new EditorManager
    const success = await editorManager.openEditor({
      path: relPath,
      isNew: false,
      onOpen: () => {
        logger.debug(`Opening note: ${relPath}`);
      },
      onClose: success => {
        logger.debug(`Editor closed with success: ${success}`);
      },
      onError: error => {
        logger.error(`Editor error: ${error.message}`);
      },
    });

    if (!success) {
      throw new Error('Error opening note');
    }

    // Read the content after the editor session
    const editedNote = await this.noteService.getNote(relPath);
    if (!editedNote) {
      throw new Error('Error reading note after edit');
    }

    logger.info(`✅ Note saved: "${topic}" at ${relPath}`);
  }

  /**
   * Analyse arbitrary note content and let the AI suggest
   * a suitable topic/title, destination folder+filename, and appropriate template.
   * Returns the chosen topic, path, and template content.
   */
  async autoCategorize(noteContent: string): Promise<{ topic: string; path: string; template: string }> {
    // Zod schema for the AI response
    const CategorizeSchema = z.object({
      title: z.string().min(1).describe('A concise title for the note'),
      folderPath: z
        .string()
        .min(1)
        .describe("Relative vault folder ending with '/' e.g. 'projects/'"),
      fileName: z.string().min(1).describe('File name including .md extension'),
      template: z.string().min(1).describe('Complete markdown template for the note, with frontmatter if needed'),
      reasoning: z.string().optional(),
    });

    const agent = mastra.getAgent('notesAgent');
    if (!agent) {
      throw new Error('notesAgent not registered in Mastra – cannot categorise quick note');
    }

    const prompt = promptService.render(PromptName.AutoCategorizeNote, {
      content: noteContent.trim().slice(0, 4000),
    });

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
      template: obj.template,
    };
  }

  /**
   * Run the AI clean-up pass on an existing note **without** opening the editor.
   * Useful after quick-note capture where the file is already written.
   */
  async cleanupNote(relPath: NoteId): Promise<void> {
    // Load the current content
    const note = await this.noteService.getNote(relPath);
    if (!note) {
      logger.warn(`Note ${relPath} not found – skipping cleanup`);
      return;
    }

    // Re-save the note to trigger cleanup hooks
    await this.noteService.writeNote(relPath, note.body);
  }
}
