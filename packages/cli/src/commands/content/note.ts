import { BaseCommand, CommandArgs } from '../base';
import { isAuthenticated } from '../../utils/config';
import readline from 'readline';
import { getApiClient } from '../../utils/apiClient';
import { DomeApi } from '@dome/dome-sdk'; // DomeApiError, DomeApiTimeoutError removed as not directly used in run
import { OutputFormat } from '../../utils/errorHandler';
import { Command } from 'commander'; // Added import
// import { createSpinner } from '../../utils/ui';

export class NoteCommand extends BaseCommand {
  constructor() {
    super('note', 'Start or append to a note session');
  }

  static register(program: Command): void {
    const cmd = program.command('note')
      .description('Start or append to a note session')
      .argument('<context>', 'Context for the note (e.g., "meeting", "ideas")')
      .option('-c, --content <content>', 'Content to add (if not provided, will start interactive mode)')
      .option('--output-format <format>', 'Output format (cli, json)');
    
    cmd.action(async (contextValue: string, optionsFromCommander: any) => {
      const commandInstance = new NoteCommand();
      const combinedArgs: CommandArgs = {
        ...optionsFromCommander,
        context: contextValue, // Add the positional argument
      };
      await commandInstance.executeRun(combinedArgs);
    });
  }

  // The parseArguments method is no longer called in the commander flow.
  // It can be removed or kept for other potential invocation methods.
  // public parseArguments(rawArgs: string[]): CommandArgs { ... }


  async run(args: CommandArgs): Promise<void> {
    const outputFormat = args.outputFormat || OutputFormat.CLI;
    const context = args.context as string; // context is now directly from CommandArgs
    const content = args.content as string | undefined;

    if (!isAuthenticated()) {
      this.error('You need to login first. Run `dome login` to authenticate.', { outputFormat });
      process.exitCode = 1;
      return;
    }

    if (!context) {
        this.error('Context for the note is required. e.g., `dome note meeting`', { outputFormat });
        process.exitCode = 1;
        return;
    }

    try {
      if (content) {
        // const spinner = createSpinner(`Adding note to category: ${context}`); // If using spinner
        // spinner.start();
        this.log(`Adding note to category: ${context}...`, outputFormat);

        const apiClient = getApiClient();
        await apiClient.notes.ingestANewNote({
          content: content,
          category: context as DomeApi.IngestNoteBodyApiSchemaCategory,
        });

        // spinner.succeed(`Note added to category: ${context}`);
        this.log(`Note added to category: ${context}`, outputFormat);
      } else {
        this.log(`Starting note session for context: ${context}`, outputFormat);
        this.log('Type your notes, one line at a time. Type "/end" to finish.', outputFormat);

        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
          prompt: '> ',
        });

        rl.prompt();

        for await (const line of rl) {
          if (line.trim().toLowerCase() === '/end') {
            this.log('Note session ended.', outputFormat);
            rl.close();
            break;
          }

          try {
            const apiClient = getApiClient();
            await apiClient.notes.ingestANewNote({
              content: line,
              category: context as DomeApi.IngestNoteBodyApiSchemaCategory,
            });
            this.log('Line added.', outputFormat);
          } catch (err: unknown) {
            this.error(err, { outputFormat }); // Let base handler format it
          }
          rl.prompt();
        }
      }
    } catch (err: unknown) {
      this.error(err, { outputFormat });
      process.exitCode = 1;
    }
  }
}

// Remove old main test function
// async function main() {
//   const command = new NoteCommand();
//   await command.execute(process.argv.slice(2));
// }

// if (require.main === module) {
//   main();
// }