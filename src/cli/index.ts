#!/usr/bin/env node

import { Command } from 'commander';
import { handleFind } from './commands/find.js';
import { handleList } from './commands/list.js';
import { handleChat } from './commands/chat.js';
import { handleNew } from './commands/new.js';
import { createIndexCommand } from './commands/indexNotes.js';
import { createReorganizeCommand } from './commands/reorganize.js';
import { createFolderCommand } from './commands/folder.js';
import { run } from './utils/command-runner.js';

// Suppress noisy debug logs in non-debug CLI mode
if (!process.env.DEBUG) {
  console.debug = () => {};
}

// Disable pino-pretty for non-interactive commands to prevent terminal issues
// This prevents logger output from interfering with inquirer prompts
if (process.argv.length > 2 && process.argv[2] !== 'chat') {
  process.env.NODE_ENV = 'production';
}

const program = new Command();

program.name('dome').description('AI-powered note-taking system').version('1.0.0');

// Find command
program
  .command('find')
  .argument('<topic...>', 'topic or title for the note')
  .description('find and open an existing note')
  .option('--no-ai', 'disable AI fallback search')
  .option('-n, --max-results <number>', 'maximum number of results to show', parseInt, 10)
  .option('-m, --min-relevance <number>', 'minimum relevance score (0-1)', parseFloat, 0.4)
  .action((topicWords, options) =>
    run(() =>
      handleFind(topicWords.join(' '), {
        useAIFallback: options.ai !== false,
        maxResults: options.maxResults,
        minRelevance: options.minRelevance,
      })
    )
  );

// New command
program
  .command('new')
  .argument('[topic...]', 'topic or title for the new note (leave blank for a quick note)')
  .description('create a new note – when no topic is given it captures a quick note')
  .action(async topicWords => {
    if (!topicWords || topicWords.length === 0) {
      const { handleQuickNew } = await import('./commands/new.js');
      await handleQuickNew();
    } else {
      await handleNew(topicWords.join(' '));
    }
  });

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
program.action(handleChat);

// Parse command line arguments (Commander will call handleChat when no sub-command is given)
await program.parseAsync(process.argv);
