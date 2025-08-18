import { FileProcessor, FileEvent, FileEventType } from './FileProcessor.js';
import { NoteSearchService } from '../services/NoteSearchService.js';
import { NoteService } from '../services/NoteService.js';
import logger from '../utils/logger.js';

export class EmbeddingProcessor extends FileProcessor {
  readonly name = 'EmbeddingGenerator';
  private searchService: NoteSearchService;

  constructor() {
    super();
    const readOnlyNoteService = new NoteService();
    this.searchService = new NoteSearchService(readOnlyNoteService);
  }

  protected async processFile(event: FileEvent): Promise<void> {
    const { type, relativePath } = event;

    if (type === FileEventType.Deleted) {
      // TODO: Remove from vector store when deletion is supported
      logger.debug(`Note deleted: ${relativePath}`);
      return;
    }

    logger.info(`[EmbeddingProcessor] Indexing vectors for: ${relativePath}`);
    // For added or changed files, generate embeddings
    try {
      await this.searchService.indexSingleNote(relativePath);
      logger.info(`[EmbeddingProcessor] Indexed vectors for: ${relativePath}`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'unknown error';
      logger.warn(`[EmbeddingProcessor] Vector embedding failed for ${relativePath}: ${errorMsg}`);
      // Don't throw - this is a non-critical enhancement
    }
  }
}
