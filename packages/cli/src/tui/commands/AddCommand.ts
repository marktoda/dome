import { CommandHandler } from '../core/types';
import { addContent } from '../../utils/api';

/**
 * Add command for quickly adding content
 */
export class AddCommand implements CommandHandler {
  private addMessage: (message: string) => void;
  private setStatus: (status: string) => void;

  /**
   * Create a new add command
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
    return 'add';
  }

  /**
   * Get command description
   */
  getDescription(): string {
    return 'Quickly add content';
  }

  /**
   * Handle command
   * @param args Command arguments
   */
  async handle(args: string[]): Promise<void> {
    if (args.length === 0) {
      this.addMessage('{red-fg}Error: Missing content. Usage: /add <content>{/red-fg}');
      return;
    }

    const content = args.join(' ');
    this.addMessage(`{bold}Adding content:{/bold} ${content}`);

    try {
      this.setStatus(' {bold}Status:{/bold} Adding content...');

      // Add content using the API
      const response = await addContent(content);

      // Display success message
      this.addMessage(`{green-fg}Content added successfully!{/green-fg}`);
      if (response && response.id) {
        this.addMessage(`{bold}ID:{/bold} ${response.id}`);
        this.addMessage(`{bold}Title:{/bold} ${response.title || 'Untitled'}`);
      }
    } catch (err) {
      this.addMessage(
        `{red-fg}Error adding content: ${
          err instanceof Error ? err.message : String(err)
        }{/red-fg}`,
      );
    }
  }
}
