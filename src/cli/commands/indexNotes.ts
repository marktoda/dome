import { Command } from 'commander';
import { NoteSearchService } from '../../core/services/NoteSearchService.js';
import { NoteService } from '../../core/services/NoteService.js';
import { run } from '../utils/command-runner.js';

import logger from '../../core/utils/logger.js';

export function createIndexCommand(): Command {
  const indexCommand = new Command('index');

  indexCommand.description('Index all notes for semantic search').action(() =>
    run(async () => {
      const noteService = new NoteService();
      const searchService = new NoteSearchService(noteService);
      logger.info('Starting note indexing for semantic search...');
      await searchService.indexNotes('full');
      logger.info('✅ Note indexing completed successfully!');
    })
  );

  return indexCommand;
}
