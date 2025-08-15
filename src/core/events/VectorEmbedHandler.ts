import { NoteSearchService } from '../services/NoteSearchService.js';
import { NoteEventHandler, NoteEvent, NoteEventType } from './noteEvents.js';
import logger from '../utils/logger.js';

// TODO: get generics working here
export class VectorEmbedHandler implements NoteEventHandler {
  constructor(private noteSearchService: NoteSearchService = new NoteSearchService()) {}

  async handle(event: NoteEvent): Promise<void> {
    if (event.type === NoteEventType.NoteCreated || event.type === NoteEventType.NoteUpdated) {
      try {
        await this.noteSearchService.indexSingleNote(event.noteId);
      } catch (err) {
        logger.warn(
          `⚠️  vector-embed hook failed: ${err instanceof Error ? err.message : 'unknown'}`
        );
      }
    }
  }
}
