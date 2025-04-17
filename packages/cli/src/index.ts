#!/usr/bin/env node

import { Command } from 'commander';
import figlet from 'figlet';
import chalk from 'chalk';
import { loadConfig } from './utils/config';
import { addCommand } from './commands/add';
import { noteCommand } from './commands/note';
import { listCommand } from './commands/list';
import { showCommand } from './commands/show';
import { searchCommand } from './commands/search';
import { chatCommand } from './commands/chat';
import { loginCommand } from './commands/login';
import { logoutCommand } from './commands/logout';
import { configCommand } from './commands/config';
import { startTui } from './tui/index';

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
  .hook('preAction', (thisCommand) => {
    // Set environment based on --prod flag
    if (thisCommand.opts().prod) {
      process.env.DOME_ENV = 'production';
    }
  });

// Display banner
console.log(chalk.cyan(figlet.textSync('dome', { font: 'Standard' })));
console.log(chalk.gray('AI-powered personal memory assistant\n'));

// Register commands
addCommand(program);
noteCommand(program);
listCommand(program);
showCommand(program);
searchCommand(program);
chatCommand(program);
loginCommand(program);
logoutCommand(program);
configCommand(program);

// Add a command to launch the TUI
program
  .command('tui')
  .description('Launch the full-screen terminal user interface')
  .action(() => {
    // Skip the banner when launching the TUI
    startTui();
  });

// Parse command line arguments
program.parse(process.argv);

// If no command is provided, show help
if (!process.argv.slice(2).length) {
  program.outputHelp();
}