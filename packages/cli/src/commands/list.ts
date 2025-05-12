import { Command } from 'commander';
import { createSpinner, error, formatTable, heading, info } from '../utils/ui';
import { isAuthenticated } from '../utils/config';
import { getApiClient } from '../utils/apiClient';
import { DomeApi, DomeApiError, DomeApiTimeoutError } from '@dome/dome-sdk';

/**
 * Register the list command
 * @param program The commander program
 */
export function listCommand(program: Command): void {
  program
    .command('list')
    .description('List notes')
    .argument('[type]', 'Type of items to list (currently only "notes" is supported)', 'notes')
    .option('-c, --category <category>', 'Filter by category')
    .option('--limit <limit>', 'Number of notes to retrieve', '50')
    .option('--offset <offset>', 'Offset for pagination', '0')
    .action(async (type: string, options: { category?: string, limit?: string, offset?: string }) => {
      if (!isAuthenticated()) {
        console.log(error('You need to login first. Run `dome login` to authenticate.'));
        process.exit(1);
      }

      if (type !== 'notes') {
        console.log(error('Invalid type. Currently, only "notes" are supported for listing.'));
        console.log(info('Example: dome list notes --category "meetings"'));
        process.exit(1);
      }

      try {
        const spinner = createSpinner(
          `Listing notes${options.category ? ` (category: ${options.category})` : ''}`,
        );
        spinner.start();

        const apiClient = getApiClient();
        const limit = parseInt(options.limit || '50', 10);
        const offset = parseInt(options.offset || '0', 10);

        const requestParams: DomeApi.GetNotesRequest = {
          limit,
          offset,
        };

        if (options.category) {
          requestParams.category = options.category as DomeApi.GetNotesRequestCategory;
        }

        const notes: DomeApi.Note[] = await apiClient.notes.listNotes(requestParams);

        spinner.stop();

        if (!notes || notes.length === 0) {
          console.log(`No notes found${options.category ? ` in category "${options.category}"` : ''}.`);
          return;
        }
        
        // The SDK's listNotes returns Note[], not an object with total.
        // We can only show the count of notes received.
        console.log(`Showing ${notes.length} notes.`);


        console.log(heading('Notes'));

        const headers = ['ID', 'Title', 'Category', 'Content Snippet', 'Created'];
        const rows = notes.map((note: DomeApi.Note) => {
          const content = note.content || '';
          const truncatedContent =
            content.length > 50 ? content.substring(0, 47) + '...' : content;

          return [
            note.id,
            note.title || '(No title)',
            note.category || '(No category)',
            truncatedContent,
            new Date(note.createdAt).toLocaleString(),
          ];
        });

        console.log(formatTable(headers, rows));
        
      } catch (err: unknown) {
        let errorMessage = 'Failed to list notes.';
        if (err instanceof DomeApiError) {
          const apiError = err as DomeApiError;
          const status = apiError.statusCode ?? 'N/A';
          let detailMessage = apiError.message;
          if (apiError.body && typeof apiError.body === 'object' && apiError.body !== null && 'message' in apiError.body && typeof (apiError.body as any).message === 'string') {
            detailMessage = (apiError.body as { message: string }).message;
          }
          errorMessage = `Error listing notes: ${detailMessage} (Status: ${status})`;
        } else if (err instanceof DomeApiTimeoutError) {
          const timeoutError = err as DomeApiTimeoutError;
          errorMessage = `Error listing notes: Request timed out. ${timeoutError.message}`;
        } else if (err instanceof Error) {
          errorMessage = `Error listing notes: ${err.message}`;
        }
        console.log(error(errorMessage));
        process.exit(1);
      }
    });
}
