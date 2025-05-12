import { Command } from 'commander';
import { GetConfigCommand } from './get';
import { SetConfigCommand } from './set';

/**
 * Registers the main 'config' command and its subcommands.
 * @param program The commander program.
 */
export function registerConfigGroupCommand(program: Command): void {
  const configCmd = program
    .command('config')
    .description('Manage dome CLI configuration');

  // Register subcommands
  GetConfigCommand.register(configCmd);
  SetConfigCommand.register(configCmd);
}