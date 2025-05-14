import { Command } from 'commander';
import { AddCommand } from './add';
import { ListCommand } from './list';
import { NoteCommand } from './note';
import { SearchCommand } from './search';
import { ShowCommand } from './show';
import { UpdateContentCommand } from './update';
import { registerGitHubGroupCommand } from './github'; // Assuming github/index.ts exports this

/**
 * Registers the main 'content' command and its subcommands.
 * @param program The commander program.
 */
export function registerContentGroupCommand(program: Command): void {
  const contentCmd = program
    .command('content')
    .description('Manage and interact with content in Dome');

  // Register direct subcommands of 'content'
  AddCommand.register(contentCmd);
  ListCommand.register(contentCmd);
  NoteCommand.register(contentCmd);
  SearchCommand.register(contentCmd);
  ShowCommand.register(contentCmd);
  UpdateContentCommand.register(contentCmd);

  // Register command groups under 'content'
  registerGitHubGroupCommand(contentCmd);
  // Add other content-related command groups here if any
}
