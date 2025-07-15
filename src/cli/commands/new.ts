import { AINoteFinder } from '../services/note-finder.js';
import { NoteManager } from '../services/note-manager.js';
import { noteStore, NoteId } from '../../mastra/core/note-store.js';
import { toRel } from '../../mastra/utils/path-utils.js';
import { extname } from 'node:path';
import logger from '../../mastra/utils/logger.js';

export async function handleNew(topic: string): Promise<void> {
  try {
    const finder = new AINoteFinder();
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
    logger.error('❌ Failed to create note:', error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}
