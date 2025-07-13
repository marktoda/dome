#!/usr/bin/env node

import { Command } from 'commander';
import { handleFind } from './commands/find.js';
import { handleList } from './commands/list.js';
import { handleChat } from './commands/chat.js';
import { createIndexCommand } from './commands/indexNotes.js';
import { createReorganizeCommand } from './commands/reorganize.js';
import { createContextCommand } from './commands/context.js';
import { handleSetup } from './commands/setup.js';

const program = new Command();

program
  .name('dome')
  .description('AI-powered note-taking system')
  .version('1.0.0');

// Find command
program
  .command('find')
  .argument('<topic>', 'search term for finding existing notes')
  .description('find and open an existing note')
  .action(handleFind);

// List command
program
  .command('list')
  .description('list all notes')
  .option('-r, --recent', 'show only recent notes')
  .option('--tags <tags>', 'filter by tags')
  .option('--json', 'output as JSON')
  .action(handleList);

// Index command
program.addCommand(createIndexCommand());

// Reorganize command
program.addCommand(createReorganizeCommand());

// Context command
program.addCommand(createContextCommand());

// Setup command
program
  .command('setup')
  .description('interactive wizard to set up context configurations for your vault')
  .action(handleSetup);

// Default action - start interactive chat
program
  .action(handleChat);

// Parse command line arguments
if (process.argv.length <= 2) {
  // No arguments provided, start chat mode
  handleChat();
} else {
  program.parse();
}