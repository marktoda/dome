import { Command } from 'commander';
import { showItem } from '../utils/api';
import { createSpinner, error, heading, subheading, formatKeyValue, formatDate } from '../utils/ui';
import { isAuthenticated } from '../utils/config';

/**
 * Register the show command
 * @param program The commander program
 */
export function showCommand(program: Command): void {
  program
    .command('show')
    .description('Show a specific note or task')
    .argument('<id>', 'ID of the item to show')
    .action(async (id: string) => {
      // Check if user is authenticated
      if (!isAuthenticated()) {
        console.log(error('You need to login first. Run `dome login` to authenticate.'));
        process.exit(1);
      }

      try {
        const spinner = createSpinner(`Fetching item with ID: ${id}`);
        spinner.start();
        
        const item = await showItem(id);
        
        spinner.stop();
        
        if (!item) {
          console.log(error(`No item found with ID: ${id}`));
          return;
        }
        
        // Determine if it's a note or task
        const isTask = 'status' in item && 'dueDate' in item;
        
        // Display the item
        console.log(heading(isTask ? 'Task Details' : 'Note Details'));
        console.log(formatKeyValue('ID', item.id));
        
        if (isTask) {
          // Display task details
          console.log(formatKeyValue('Description', item.description || '(No description)'));
          console.log(formatKeyValue('Status', item.status));
          console.log(formatKeyValue('Due Date', item.dueDate ? formatDate(item.dueDate) : 'No due date'));
          console.log(formatKeyValue('Created', formatDate(item.createdAt)));
          
          if (item.tags && item.tags.length > 0) {
            console.log(formatKeyValue('Tags', item.tags.join(', ')));
          }
          
          if (item.reminders && item.reminders.length > 0) {
            console.log(subheading('Reminders'));
            item.reminders.forEach((reminder: any) => {
              console.log(`  • ${formatDate(reminder.remindAt)}`);
            });
          }
        } else {
          // Display note details
          console.log(formatKeyValue('Title', item.title || '(No title)'));
          console.log(formatKeyValue('Created', formatDate(item.createdAt)));
          
          if (item.tags && item.tags.length > 0) {
            console.log(formatKeyValue('Tags', item.tags.join(', ')));
          }
          
          console.log(subheading('Content'));
          console.log(item.content);
        }
      } catch (err) {
        console.log(error(`Failed to show item: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });
}