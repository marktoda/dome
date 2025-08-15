import { NoteSearchService } from '../../../../core/services/NoteSearchService.js';
import { afterSaveHook, NoteSaveContext } from '../note-hooks.js';
import logger from '../../../../core/utils/logger.js';

async function vectorEmbeddingImpl(ctx: NoteSaveContext): Promise<void> {
  const noteSearchService = new NoteSearchService();
  try {
    await noteSearchService.indexSingleNote(ctx.relPath);
  } catch (err) {
    logger.warn(`⚠️  vector-embed hook failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }
}

export const vectorEmbeddingHook = afterSaveHook(
  'Vector Embedding',
  vectorEmbeddingImpl,
  'Upserts note into vector index after save',
  {
    id: 'vector-embed',
    priority: 0,
    pathIncludeGlobs: ['**/*.md', '**/*.markdown'],
  }
);
