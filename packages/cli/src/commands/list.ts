import { Command } from 'commander';
import { listItems } from '../utils/api';
import { createSpinner, error, formatTable, heading } from '../utils/ui';
import { isAuthenticated } from '../utils/config';

/**
 * Register the list command
 * @param program The commander program
 */
export function listCommand(program: Command): void {
  program
    .command('list')
    .description('List notes or tasks')
    .argument('<type>', 'Type of items to list (notes or tasks)')
    .option('-f, --filter <filter>', 'Filter criteria (e.g., "tag:work", "date:today")')
    .action(async (type: string, options: { filter?: string }) => {
      // Check if user is authenticated
      if (!isAuthenticated()) {
        console.log(error('You need to login first. Run `dome login` to authenticate.'));
        process.exit(1);
      }

      // Validate type
      if (type !== 'notes' && type !== 'tasks') {
        console.log(error('Type must be either "notes" or "tasks".'));
        process.exit(1);
      }

      try {
        const spinner = createSpinner(
          `Listing ${type}${options.filter ? ` (filter: ${options.filter})` : ''}`,
        );
        spinner.start();

        const result = await listItems(type as 'notes' | 'tasks', options.filter);

        spinner.stop();

        // Handle different response formats based on type
        const items = type === 'notes' ? result.notes : result.items;

        if (!items || items.length === 0) {
          console.log(`No ${type} found.`);
          return;
        }

        console.log(heading(`${type.charAt(0).toUpperCase() + type.slice(1)}`));

        if (type === 'notes') {
          // Format notes as a table
          const headers = ['ID', 'Title', 'Created', 'Tags'];
          const rows = items.map((note: any) => [
            note.id,
            note.title || '(No title)',
            new Date(note.createdAt).toLocaleString(),
            (note.tags || []).join(', '),
          ]);

          console.log(formatTable(headers, rows));
        } else {
          // Format tasks as a table
          const headers = ['ID', 'Description', 'Due Date', 'Status'];
          const rows = items.map((task: any) => [
            task.id,
            task.description || '(No description)',
            task.dueDate ? new Date(task.dueDate).toLocaleString() : 'No due date',
            task.status,
          ]);

          console.log(formatTable(headers, rows));
        }
      } catch (err) {
        console.log(
          error(`Failed to list ${type}: ${err instanceof Error ? err.message : String(err)}`),
        );
        process.exit(1);
      }
    });
}
