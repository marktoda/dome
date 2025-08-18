import { NoteCreatedEvent, NoteUpdatedEvent } from '../types.js';
import { NoteSearchService } from '../../services/NoteSearchService.js';
import { NoteService } from '../../services/NoteService.js';
import { createNoOpEventBus } from '../index.js';
import logger from '../../utils/logger.js';

// Create a read-only NoteService for the search service
// This is safe because NoteSearchService only reads notes, never writes
const readOnlyNoteService = new NoteService(createNoOpEventBus());
const noteSearchService = new NoteSearchService(readOnlyNoteService);

export async function handleVectorEmbed(
  event: NoteCreatedEvent | NoteUpdatedEvent
): Promise<void> {
  try {
    await noteSearchService.indexSingleNote(event.noteId);
    logger.debug(`Indexed vectors for note: ${event.noteId}`);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'unknown error';
    logger.warn(`Vector embedding failed for ${event.noteId}: ${errorMsg}`);
    // Don't throw - this is a non-critical enhancement
  }
}