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
  constructor(
    addMessage: (message: string) => void,
    setStatus: (status: string) => void
  ) {
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

      // Handle different response formats
      let items: any[] = [];
      if (Array.isArray(response)) {
        items = response;
      } else if (typeof response === 'object' && response !== null) {
        items = (response as any).notes || (response as any).tasks || [];
      }

      if (items.length === 0) {
        this.addMessage(`No ${type} found.`);
      } else {
        this.addMessage(`Found ${items.length} ${type}:`);
        this.addMessage('');
        
        items.forEach((item: any, index: number) => {
          if (type === 'notes') {
            // Handle note item structure
            const title = item.title || 'Untitled';
            const content = item.body || item.content || '';
            const date = new Date(item.createdAt).toLocaleString();
            
            this.addMessage(`{bold}${index + 1}. ${title}{/bold}`);
            this.addMessage(`{gray-fg}Created: ${date}{/gray-fg}`);
            this.addMessage(`${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`);
            this.addMessage('');
          } else {
            // Handle task item structure
            const title = item.description || item.title || 'Untitled task';
            const status = item.status || 'unknown';
            const date = item.createdAt ? new Date(item.createdAt).toLocaleString() : 'Unknown';
            
            this.addMessage(`{bold}${index + 1}. ${title}{/bold}`);
            this.addMessage(`{gray-fg}Status: ${status} | Created: ${date}{/gray-fg}`);
            this.addMessage('');
          }
        });
      }
    } catch (err) {
      this.addMessage(
        `{red-fg}Error listing ${type}: ${
          err instanceof Error ? err.message : String(err)
        }{/red-fg}`
      );
    }
  }
}