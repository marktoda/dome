#!/usr/bin/env node

import { Command } from 'commander';
import figlet from 'figlet';
import chalk from 'chalk';
import { loadConfig } from './utils/config';

// Refactored commands (import classes and group registers)
import { ChatCommand } from './commands/session/chat';
import { LoginCommand } from './commands/auth/login';
import { LogoutCommand } from './commands/auth/logout';
import { RegisterCommand } from './commands/auth/register'; // Newly refactored
import { registerConfigGroupCommand } from './commands/config'; // Newly refactored group
import { registerContentGroupCommand } from './commands/content'; // Newly refactored group

// Unrefactored commands (should be empty if all are done, or list any remaining)
// For now, assuming all relevant commands mentioned in the task are covered by new groups/classes.
// If 'listCommand', 'showCommand' etc. were separate top-level commands and NOT part of 'content' group,
// they would need to be handled or confirmed as removed/subsumed.
// Based on the refactoring, they are now part of the 'content' group.

import { startPromptTui } from './tui/index';

// Load configuration
const config = loadConfig();

// Create the program
const program = new Command();

// Set up the program
program
  .name('dome')
  .description('Terminal UI client for the dome API')
  .version('0.1.0')
  .option('--prod', 'Use production environment')
  .hook('preAction', thisCommand => {
    // Set environment based on --prod flag
    if (thisCommand.opts().prod) {
      process.env.DOME_ENV = 'production';
    }
  });

// Display banner only when no arguments or when help is requested
if (
  !process.argv.slice(2).length ||
  process.argv.includes('--help') ||
  process.argv.includes('-h')
) {
  console.log(chalk.cyan(figlet.textSync('dome', { font: 'Standard' })));
  console.log(chalk.gray('AI-powered personal memory assistant\n'));
}

// Register commands

// Refactored commands
ChatCommand.register(program);
LoginCommand.register(program);
LogoutCommand.register(program);
RegisterCommand.register(program); // Newly refactored

// Register command groups
registerConfigGroupCommand(program); // Newly refactored group
registerContentGroupCommand(program); // Newly refactored group, includes note, search, list, show, add, github

// Any truly unrefactored top-level commands would be registered here.
// e.g. if there was a `cli/src/commands/foo.ts` that wasn't touched.
// For this task, all specified commands have been addressed.

// Add a command to launch the prompt-based TUI
program
  .command('tui')
  .description('Launch the terminal user interface')
  .action(() => {
    startPromptTui();
  });

// Parse command line arguments
program.parse(process.argv);

// If no command is provided, show help
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
