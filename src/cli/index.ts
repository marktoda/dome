#!/usr/bin/env node

import { Command } from 'commander';
import { handleFind } from './commands/find.js';
import { handleList } from './commands/list.js';
import { handleChat } from './commands/chat.js';
import { handleNew } from './commands/new.js';
import { createIndexCommand } from './commands/indexNotes.js';
import { createReorganizeCommand } from './commands/reorganize.js';
import { createFolderCommand } from './commands/folder.js';

const program = new Command();

program
  .name('dome')
  .description('AI-powered note-taking system')
  .version('1.0.0');

// Find command
program
  .command('find')
  .argument('<topic...>', 'topic or title for the note')
  .description('find and open an existing note')
  .action(async (topicWords) => await handleFind(topicWords.join(' ')));

// New command
program
  .command('new')
  .argument('<topic...>', 'topic or title for the new note')
  .description('create a new note with AI-generated template')
  .action(async (topicWords) => await handleNew(topicWords.join(' ')));

// List command
program
  .command('list')
  .description('list all notes')
  .option('-r, --recent', 'show only recent notes')
  .option('--tags <tags>', 'filter by tags')
  .option('--json', 'output as JSON')
  .action(async () => await handleList());

// Index command
program.addCommand(createIndexCommand());

// Reorganize command
program.addCommand(createReorganizeCommand());

// Folder command
program.addCommand(createFolderCommand());

// Default action - start interactive chat
program
  .action(handleChat);

// Parse command line arguments
if (process.argv.length <= 2) {
  // No arguments provided, start chat mode
  handleChat();
} else {
  await program.parseAsync();
  process.exit(0);
}
