import { Command } from 'commander';
import { createSpinner, error, heading, subheading, formatKeyValue, formatDate, info } from '../utils/ui';
import { isAuthenticated } from '../utils/config';
import { getApiClient } from '../utils/apiClient';
import { DomeApi, DomeApiError, DomeApiTimeoutError } from '@dome/dome-sdk';

/**
 * Register the show command
 * @param program The commander program
 */
export function showCommand(program: Command): void {
  program
    .command('show')
    .description('Show details of a specific note')
    .argument('<id>', 'ID of the note to show')
    // Add type argument for future extension, but default/enforce 'note' for now
    .argument('[type]', 'Type of item to show (currently only "note" is supported)', 'note')
    .action(async (id: string, type: string) => {
      if (!isAuthenticated()) {
        console.log(error('You need to login first. Run `dome login` to authenticate.'));
        process.exit(1);
      }

      if (type !== 'note') {
        console.log(error('Invalid type. Currently, only "note" is supported for showing details.'));
        console.log(info('Example: dome show <note_id>'));
        process.exit(1);
      }

      let spinner = createSpinner(`Fetching note with ID: ${id}`); // Declare spinner outside try
      try {
        spinner.start();

        const apiClient = getApiClient();
        const note: DomeApi.Note = await apiClient.notes.getANoteById(id);

        spinner.stop(); // Stop on success

        // Display note details
        console.log(heading('Note Details'));
        console.log(formatKeyValue('ID', note.id));
        console.log(formatKeyValue('Title', note.title || '(No title)'));
        console.log(formatKeyValue('Category', note.category || '(No category)'));
        console.log(formatKeyValue('MIME Type', note.mimeType));
        console.log(formatKeyValue('Size (bytes)', note.size.toString()));
        console.log(formatKeyValue('Created', formatDate(new Date(note.createdAt))));
        if (note.url) {
          console.log(formatKeyValue('URL (for large content)', note.url));
        }
        if (note.customMetadata && Object.keys(note.customMetadata).length > 0) {
            console.log(subheading('Custom Metadata'));
            for (const key in note.customMetadata) {
                console.log(formatKeyValue(`  ${key}`, String(note.customMetadata[key])));
            }
        }

        console.log(subheading('Content'));
        console.log(note.content || '(No content)');

      } catch (err: unknown) {
        let errorMessage = `Failed to show note with ID ${id}.`;
        // Ensure spinner is stopped in case of an error
        // It's better to get the spinner instance used in the try block if possible,
        // but creating a new one to call .stop() might not work as expected unless it's a global singleton.
        // For simplicity, we'll assume the spinner might have been created and try to handle it.
        // A better pattern is to define spinner outside try and stop it in finally or before logging error.
        // However, the original code creates spinner inside try.

        if (err instanceof DomeApiError) {
          const apiError = err as DomeApiError;
          if (apiError.statusCode === 404) {
            errorMessage = `Error: Note with ID "${id}" not found.`;
          } else {
            errorMessage = `Error fetching note: ${apiError.message} (Status: ${apiError.statusCode || 'N/A'})`;
          }
        } else if (err instanceof DomeApiTimeoutError) {
          const timeoutError = err as DomeApiTimeoutError;
          errorMessage = `Error fetching note: Request timed out. ${timeoutError.message}`;
        } else if (err instanceof Error) {
          errorMessage = `Error fetching note: ${err.message}`;
        }
        
        if (spinner && typeof spinner.stop === 'function' && (spinner as any).isSpinning) { // Check if spinner was started and stop it
            spinner.stop();
        }

        console.log(error(errorMessage));
        process.exit(1);
      }
    });
}

