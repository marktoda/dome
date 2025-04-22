import { Command } from 'commander';
import { addContent } from '../utils/api';
import { createSpinner, success, error } from '../utils/ui';
import { isAuthenticated } from '../utils/config';
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
          await addContent(fileContent);

          spinner.succeed(`Added file: ${fileName}`);
        } else {
          // Add text content
          const contentPreview = content.length > 40 ? `${content.substring(0, 40)}...` : content;
          const spinner = createSpinner(`Adding: "${contentPreview}"`);
          spinner.start();

          await addContent(content);

          spinner.succeed('Added to dome');
        }
      } catch (err) {
        console.log(
          error(`Failed to add content: ${err instanceof Error ? err.message : String(err)}`),
        );
        process.exit(1);
      }
    });
}
