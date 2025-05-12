import { Command } from 'commander';
import { createSpinner, success, error, info } from '../utils/ui';
import { isAuthenticated } from '../utils/config';
import readline from 'readline';
import { getApiClient } from '../utils/apiClient';
import { DomeApi, DomeApiError, DomeApiTimeoutError } from '@dome/dome-sdk';

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
          const spinner = createSpinner(`Adding note to category: ${context}`);
          spinner.start();

          const apiClient = getApiClient();
          await apiClient.notes.ingestANewNote({
            content: options.content,
            category: context as DomeApi.IngestNoteBodyApiSchemaCategory, // Assuming context maps to category
            // title: `Note in ${context}` // Optionally set a title
          });

          spinner.succeed(`Note added to category: ${context}`);
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
              const apiClient = getApiClient();
              await apiClient.notes.ingestANewNote({
                content: line,
                category: context as DomeApi.IngestNoteBodyApiSchemaCategory, // Assuming context maps to category
                 // title: `Note line in ${context}` // Optionally set a title
              });
              console.log(success('Line added.'));
            } catch (err: unknown) {
              let errorMessage = 'Failed to add line.';
              if (err instanceof DomeApiError) {
                const apiError = err as DomeApiError;
                errorMessage = `Failed to add line: ${apiError.message} (Status: ${apiError.statusCode || 'N/A'})`;
              } else if (err instanceof DomeApiTimeoutError) {
                const timeoutError = err as DomeApiTimeoutError;
                errorMessage = `Failed to add line: Request timed out. ${timeoutError.message}`;
              } else if (err instanceof Error) {
                errorMessage = `Failed to add line: ${err.message}`;
              }
              console.log(error(errorMessage));
            }

            rl.prompt();
          });
        }
      } catch (err: unknown) {
        let errorMessage = 'Failed to process note command.';
        if (err instanceof DomeApiError) {
          const apiError = err as DomeApiError;
          errorMessage = `Error: ${apiError.message} (Status: ${apiError.statusCode || 'N/A'})`;
        } else if (err instanceof DomeApiTimeoutError) {
          const timeoutError = err as DomeApiTimeoutError;
          errorMessage = `Error: Request timed out. ${timeoutError.message}`;
        } else if (err instanceof Error) {
          errorMessage = `Error: ${err.message}`;
        }
        console.log(error(errorMessage));
        process.exit(1);
      }
    });
}
