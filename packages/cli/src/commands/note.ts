import { Command } from 'commander';
import { addNote } from '../utils/api';
import { createSpinner, success, error, info } from '../utils/ui';
import { isAuthenticated } from '../utils/config';
import readline from 'readline';

/**
 * Register the note command
 * @param program The commander program
 */
export function noteCommand(program: Command): void {
  program
    .command('note')
    .description('Start or append to a note session')
    .argument('<context>', 'Context for the note (e.g., "meeting", "ideas")')
    .option(
      '-c, --content <content>',
      'Content to add (if not provided, will start interactive mode)',
    )
    .action(async (context: string, options: { content?: string }) => {
      // Check if user is authenticated
      if (!isAuthenticated()) {
        console.log(error('You need to login first. Run `dome login` to authenticate.'));
        process.exit(1);
      }

      try {
        if (options.content) {
          // Add content directly
          const spinner = createSpinner(`Adding note to context: ${context}`);
          spinner.start();

          await addNote(context, options.content);

          spinner.succeed(`Note added to context: ${context}`);
        } else {
          // Start interactive mode
          console.log(info(`Starting note session for context: ${context}`));
          console.log(info('Type your notes, one line at a time. Type "/end" to finish.'));

          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: '> ',
          });

          rl.prompt();

          rl.on('line', async line => {
            if (line.trim() === '/end') {
              console.log(success('Note session ended.'));
              rl.close();
              return;
            }

            try {
              await addNote(context, line);
              console.log(success('Line added.'));
            } catch (err) {
              console.log(
                error(`Failed to add line: ${err instanceof Error ? err.message : String(err)}`),
              );
            }

            rl.prompt();
          });
        }
      } catch (err) {
        console.log(
          error(`Failed to add note: ${err instanceof Error ? err.message : String(err)}`),
        );
        process.exit(1);
      }
    });
}
