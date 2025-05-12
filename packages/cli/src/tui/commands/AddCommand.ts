import { CommandHandler } from '../core/types';
import { getApiClient } from '../../utils/apiClient';
import { DomeApi, DomeApiError, DomeApiTimeoutError } from '@dome/dome-sdk';

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
      const apiClient = getApiClient();
      const response: DomeApi.Note = await apiClient.notes.ingestANewNote({ content });

      // Display success message
      this.addMessage(`{green-fg}Content added successfully!{/green-fg}`);
      this.addMessage(`{bold}ID:{/bold} ${response.id}`);
      this.addMessage(`{bold}Title:{/bold} ${response.title || '(No title)'}`);
      if (response.category) {
        this.addMessage(`{bold}Category:{/bold} ${response.category}`);
      }
      
    } catch (err: unknown) {
      let errorMessage = 'Error adding content.';
      if (err instanceof DomeApiError) {
        const apiError = err as DomeApiError;
        errorMessage = `API Error: ${apiError.message} (Status: ${apiError.statusCode || 'N/A'})`;
      } else if (err instanceof DomeApiTimeoutError) {
        const timeoutError = err as DomeApiTimeoutError;
        errorMessage = `API Timeout Error: ${timeoutError.message}`;
      } else if (err instanceof Error) {
        errorMessage = `Error adding content: ${err.message}`;
      }
      this.addMessage(`{red-fg}${errorMessage}{/red-fg}`);
    }
  }
}
