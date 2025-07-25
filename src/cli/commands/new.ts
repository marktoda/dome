import { NoteFinder } from '../domain/search/NoteFinder.js';
import { NoteManager } from '../services/note-manager.js';
import { noteStore, NoteId } from '../../mastra/core/note-store.js';
import { toRel } from '../../mastra/utils/path-utils.js';
import { extname } from 'node:path';
import { editorManager } from '../services/editor-manager.js';
import logger from '../../mastra/utils/logger.js';

export async function handleNew(topic: string): Promise<void> {
  try {
    const finder = new NoteFinder();
    const noteManager = new NoteManager();

    logger.info(`🔍 Searching for folders to place "${topic}"...`);

    // Find existing note only
    const { path, template } = await finder.findPlaceForTopic(topic);

    // Ensure vault-relative identifier and .md extension
    let noteId = toRel(path) as NoteId;
    if (!extname(noteId)) {
      noteId = `${noteId}.md` as NoteId;
    }

    // Check if the note already exists in the vault
    const fileExists = await noteStore.exists(noteId);

    if (fileExists) {
      logger.warn(`⚠️  Note already exists at: ${path}`);
      logger.info('📝 Opening existing note for editing...');
    } else {
      // Write template to file only if it doesn't exist
      logger.info(`📝 Creating note with template at: ${path}`);
      await noteStore.store(noteId, template);
    }

    // Open in editor (pass the cleaned id to the manager)
    await noteManager.editNote(topic, noteId);
  } catch (error) {
    logger.error(
      '❌ Failed to create note:',
      error instanceof Error ? error.message : 'Unknown error'
    );
    process.exit(1);
  }
}

/**
 * Quick-capture flow when the user runs `dome new` with **no** topic.
 * 1. Create a temp note in `inbox/` with a timestamp filename
 * 2. Let the user jot down their thoughts in the editor
 * 3. Ask the AI to categorise the note → topic + destination folder
 * 4. Move the note to its new home (renaming the file)
 * 5. Run the standard NoteManager edit flow (which will summarise & tidy)
 */
export async function handleQuickNew(): Promise<void> {
  try {
    // Timestamp-based temp filename
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const tempRel: NoteId = `inbox/quick-note-${ts}.md` as NoteId;

    // Step 1-2: open in editor (EditorManager will create the file)
    const editorOk = await editorManager.openEditor({ path: tempRel, isNew: false });
    if (!editorOk) {
      logger.warn('🚫 Quick note creation cancelled');
      process.exit(0);
    }

    // Read the freshly written content
    const quickNote = await noteStore.get(tempRel);
    if (!quickNote) {
      logger.error('❌ Could not read quick note after editing');
      process.exit(1);
    }

    // Step 3: persist the note to trigger rewrite + auto-placement hooks
    await noteStore.store(tempRel, quickNote.raw);

    logger.info('✅ Quick note saved');
    // Explicitly exit to avoid lingering DB handles/open timers
    process.exit(0);
  } catch (error) {
    logger.error('❌ Failed to create quick note:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
