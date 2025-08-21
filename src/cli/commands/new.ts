import { NoteManager } from '../services/note-manager.js';
import { NoteService, NoteId } from '../../core/services/NoteService.js';

import { editorManager } from '../services/editor-manager.js';
import logger from '../../core/utils/logger.js';

export async function handleNew(topic: string): Promise<void> {
  const noteService = new NoteService();
  try {
    const noteManager = new NoteManager();

    // Create a simple filename from the topic
    const filename = topic.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-');
    const noteId = `${filename}.md` as NoteId;

    // Check if the note already exists in the vault
    const fileExists = await noteService.store.exists(noteId);

    if (fileExists) {
      logger.warn(`⚠️  Note already exists: ${noteId}`);
      logger.info('📝 Opening existing note for editing...');
    } else {
      // Create a basic template
      const template = `# ${topic}\n\n`;
      logger.info(`📝 Creating new note: ${noteId}`);
      await noteService.store.store(noteId, template);
    }

    // Open in editor
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
  const noteService = new NoteService();
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
    const quickNote = await noteService.getNote(tempRel);
    if (!quickNote) {
      logger.error('❌ Could not read quick note after editing');
      process.exit(1);
    }

    // Step 3: persist the note to trigger rewrite + auto-placement hooks
    await noteService.writeNote(tempRel, quickNote.body);

    logger.info('✅ Quick note saved');
    // Explicitly exit to avoid lingering DB handles/open timers
    process.exit(0);
  } catch (error) {
    logger.error('❌ Failed to create quick note:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
