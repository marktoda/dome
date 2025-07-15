import { AINoteFinder } from '../services/note-finder.js';
import { NoteManager } from '../services/note-manager.js';
import { writeNote, prepareNoteFolder } from '../../mastra/core/notes.js';
import { basename } from 'node:path';
import fs from 'node:fs/promises';
import logger from '../../mastra/utils/logger.js';

export async function handleNew(topic: string): Promise<void> {
  try {
    const finder = new AINoteFinder();
    const noteManager = new NoteManager();

    logger.info(`🔍 Searching for folders to place "${topic}"...`);

    // Find existing note only
    const { path, template } = await finder.findPlaceForTopic(topic);
    const fullPath = await prepareNoteFolder(path);

    // Check if file already exists
    let fileExists = false;
    try {
      await fs.access(fullPath);
      fileExists = true;
    } catch {
      // File doesn't exist, which is what we want
    }

    if (fileExists) {
      logger.warn(`⚠️  Note already exists at: ${path}`);
      logger.info('📝 Opening existing note for editing...');
    } else {
      // Write template to file only if it doesn't exist
      logger.info(`📝 Creating note with template at: ${path}`);
      await writeNote(path, template, basename(path, '.md'));
    }

    // Open in editor
    await noteManager.editNote(topic, path);
  } catch (error) {
    logger.error('❌ Failed to create note:', error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}
