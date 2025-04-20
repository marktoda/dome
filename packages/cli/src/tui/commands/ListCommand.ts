import { CommandHandler } from '../core/types';
import { listNotes, listTasks } from '../../utils/api';

/**
 * List command for listing notes and tasks
 */
export class ListCommand implements CommandHandler {
  private addMessage: (message: string) => void;
  private setStatus: (status: string) => void;

  /**
   * Create a new list command
   * @param addMessage Function to add a message to the output
   * @param setStatus Function to set the status bar content
   */
  constructor(addMessage: (message: string) => void, setStatus: (status: string) => void) {
    this.addMessage = addMessage;
    this.setStatus = setStatus;
  }

  /**
   * Get command name
   */
  getName(): string {
    return 'list';
  }

  /**
   * Get command description
   */
  getDescription(): string {
    return 'List notes and tasks';
  }

  /**
   * Handle command
   * @param args Command arguments
   */
  async handle(args: string[]): Promise<void> {
    const type = args[0] || 'notes';

    if (type !== 'notes' && type !== 'tasks') {
      this.addMessage('{red-fg}Error: Invalid list type. Usage: /list [notes|tasks]{/red-fg}');
      return;
    }

    this.addMessage(`{bold}Listing ${type}:{/bold}`);

    try {
      this.setStatus(` {bold}Status:{/bold} Loading ${type}...`);

      const response = type === 'notes' ? await listNotes() : await listTasks();

      // The response should already be an array from our updated API functions
      const items = Array.isArray(response) ? response : [];

      if (items.length === 0) {
        this.addMessage(`No ${type} found.`);
      } else {
        this.addMessage(`Found ${items.length} ${type}:`);
        this.addMessage('');

        items.forEach((item: any, index: number) => {
          if (type === 'notes') {
            // Handle note item structure with new API format
            const title = item.title || 'Untitled';
            const content = item.body || '';
            const date = new Date(item.createdAt).toLocaleString();
            
            // Try to extract tags from metadata if available
            let tags: string[] = [];
            if (item.metadata) {
              try {
                const metadata = typeof item.metadata === 'string'
                  ? JSON.parse(item.metadata)
                  : item.metadata;
                
                if (metadata.tags && Array.isArray(metadata.tags)) {
                  tags = metadata.tags;
                }
              } catch (e) {
                // Ignore parsing errors
              }
            }

            this.addMessage(`{bold}${index + 1}. ${title}{/bold}`);
            this.addMessage(`{gray-fg}Created: ${date} | Type: ${item.contentType || 'text/plain'}{/gray-fg}`);
            if (tags.length > 0) {
              this.addMessage(`{gray-fg}Tags: ${tags.join(', ')}{/gray-fg}`);
            }
            this.addMessage(`${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`);
            this.addMessage('');
          } else {
            // Handle task item structure with new API format
            const title = item.title || 'Untitled task';
            const description = item.description || '';
            const status = item.status || 'pending';
            const priority = item.priority || 'medium';
            const date = item.createdAt ? new Date(item.createdAt).toLocaleString() : 'Unknown';
            const dueDate = item.dueDate ? new Date(item.dueDate).toLocaleString() : 'None';

            this.addMessage(`{bold}${index + 1}. ${title}{/bold}`);
            this.addMessage(`{gray-fg}Status: ${status} | Priority: ${priority} | Due: ${dueDate}{/gray-fg}`);
            this.addMessage(`{gray-fg}Created: ${date}{/gray-fg}`);
            if (description) {
              this.addMessage(description.substring(0, 100) + (description.length > 100 ? '...' : ''));
            }
            this.addMessage('');
          }
        });
      }
    } catch (err) {
      this.addMessage(
        `{red-fg}Error listing ${type}: ${
          err instanceof Error ? err.message : String(err)
        }{/red-fg}`,
      );
    }
  }
}
