import { Command } from 'commander';
import { NoteSearchService } from '../../core/services/NoteSearchService.js';
import logger from '../../core/utils/logger.js';

export function createIndexCommand(): Command {
  const indexCommand = new Command('index');
  const searchService = new NoteSearchService();

  indexCommand.description('Index all notes for semantic search').action(async () => {
    try {
      logger.info('Starting note indexing for semantic search...');
      await searchService.indexNotes('full');
      logger.info('✅ Note indexing completed successfully!');
    } catch (error) {
      logger.error(error, '❌ Error during indexing');
      process.exit(1);
    }
  });

  return indexCommand;
}
