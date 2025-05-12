import { Command } from 'commander';
import { AddGitHubRepoCommand } from './add';

/**
 * Registers the 'github' command group and its subcommands.
 * @param program The parent commander program or command.
 */
export function registerGitHubGroupCommand(program: Command): void {
  const githubCmd = program
    .command('github')
    .description('Manage GitHub repositories in Dome');

  // Register subcommands for github
  AddGitHubRepoCommand.register(githubCmd);
  // Add other github subcommands here if any in the future
}