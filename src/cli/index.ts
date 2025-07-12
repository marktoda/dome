#!/usr/bin/env node

import { Command } from 'commander';
import { handleAdd } from './commands/add.js';
import { handleList } from './commands/list.js';
import { handleChat } from './commands/chat.js';
import { createIndexCommand } from './commands/indexNotes.js';
import { createReorganizeCommand } from './commands/reorganize.js';

const program = new Command();

program
  .name('dome')
  .description('AI-powered note-taking system')
  .version('1.0.0');

// Add command
program
  .command('add')
  .argument('<topic>', 'note topic')
  .description('create or edit a note on the given topic')
  .action(handleAdd);

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