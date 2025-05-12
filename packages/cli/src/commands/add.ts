import { Command } from 'commander';
import { createSpinner, success, error } from '../utils/ui';
import { isAuthenticated } from '../utils/config';
import { getApiClient } from '../utils/apiClient';
import { DomeApiError, DomeApiTimeoutError } from '@dome/dome-sdk';
import fs from 'fs';
import path from 'path';

/**
 * Register the add command
 * @param program The commander program
 */
export function addCommand(program: Command): void {
  program
    .command('add')
    .description('Add new content to dome')
    .argument('<content>', 'Content to add (text, file path, or URL)')
    .action(async (content: string) => {
      // Check if user is authenticated
      if (!isAuthenticated()) {
        console.log(error('You need to login first. Run `dome login` to authenticate.'));
        process.exit(1);
      }

      try {
        // Check if content is a file path
        if (fs.existsSync(content) && fs.statSync(content).isFile()) {
          const fileName = path.basename(content);
          const spinner = createSpinner(`Adding file: ${fileName}`);
          spinner.start();

          // Read file content
          const fileContent = fs.readFileSync(content, 'utf-8');

          // Add file content
          const apiClient = getApiClient();
          await apiClient.notes.ingestANewNote({
            content: fileContent,
            title: fileName, // Use filename as title
            // category: 'file', // Optional: set a category
          });
          spinner.succeed(`Added file: ${fileName}`);
        } else {
          // Add text content
          const apiClient = getApiClient();
          const contentPreview = content.length > 40 ? `${content.substring(0, 40)}...` : content;
          const spinner = createSpinner(`Adding: "${contentPreview}"`);
          spinner.start();

          await apiClient.notes.ingestANewNote({ content: content });
          spinner.succeed('Added to dome');
        }
      } catch (err: unknown) {
        let errorMessage = 'Failed to add content.';
        // Check for DomeApiError first, as it's more specific
        if (err instanceof DomeApiError) {
          const apiError = err as DomeApiError; // Explicit cast after instanceof
          const status = apiError.statusCode ?? 'N/A';
          let detailMessage = apiError.message;
          if (apiError.body && typeof apiError.body === 'object' && apiError.body !== null && 'message' in apiError.body && typeof (apiError.body as any).message === 'string') {
            detailMessage = (apiError.body as { message: string }).message;
          }
          errorMessage = `Error adding content: ${detailMessage} (Status: ${status})`;
        } else if (err instanceof DomeApiTimeoutError) {
          const timeoutError = err as DomeApiTimeoutError; // Explicit cast
          errorMessage = `Error adding content: Request timed out. ${timeoutError.message}`;
        } else if (err instanceof Error) {
          // Fallback for generic errors
          errorMessage = `Error adding content: ${err.message}`;
        }
        // For truly unknown errors not caught above, the initial `errorMessage` will be used.
        console.log(error(errorMessage));
        process.exit(1);
      }
    });
}
