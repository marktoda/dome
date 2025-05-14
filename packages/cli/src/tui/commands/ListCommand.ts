import { CommandHandler } from '../core/types';
import { getApiClient } from '../../utils/apiClient';
import { DomeApi, DomeApiError, DomeApiTimeoutError } from '@dome/dome-sdk';

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

    if (type !== 'notes') {
      this.addMessage('{red-fg}Error: Invalid list type. Usage: /list notes [category]{/red-fg}');
      return;
    }
    const category = args[1]; // Optional category filter

    this.addMessage(`{bold}Listing notes${category ? ` (category: ${category})` : ''}:{/bold}`);

    try {
      this.setStatus(` {bold}Status:{/bold} Loading notes...`);
      this.addMessage(`{gray-fg}Fetching notes from the server...{/gray-fg}`);

      const apiClient = await getApiClient();
      const requestParams: DomeApi.GetNotesRequest = { limit: 50, offset: 0 }; // Default limit/offset
      if (category) {
        requestParams.category = category as DomeApi.GetNotesRequestCategory;
      }

      const notes: DomeApi.Note[] = await apiClient.notes.listNotes(requestParams);
      
      this.setStatus(` {bold}Status:{/bold} Processing notes...`);

      if (notes.length === 0) {
        this.addMessage(`No notes found${category ? ` in category "${category}"` : ''}.`);
      } else {
        this.addMessage(`Found ${notes.length} notes:`);
        this.addMessage('');

        notes.forEach((note: DomeApi.Note, index: number) => {
          const title = note.title || '(No title)';
          const content = note.content || '';
          const date = new Date(note.createdAt).toLocaleString();
          const noteCategory = note.category || '(No category)';

          this.addMessage(`{bold}${index + 1}. ${title}{/bold}`);
          this.addMessage(
            `{gray-fg}ID: ${note.id} | Category: ${noteCategory} | Created: ${date}{/gray-fg}`,
          );
          this.addMessage(`${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`);
          this.addMessage('');
        });
      }
      this.setStatus(` {bold}Status:{/bold} ${notes.length} notes listed successfully`);
    } catch (err: unknown) {
      let errorMessage = 'Error listing notes.';
      if (err instanceof DomeApiError) {
        const apiError = err as DomeApiError;
        errorMessage = `API Error: ${apiError.message} (Status: ${apiError.statusCode || 'N/A'})`;
      } else if (err instanceof DomeApiTimeoutError) {
        const timeoutError = err as DomeApiTimeoutError;
        errorMessage = `API Timeout Error: ${timeoutError.message}`;
      } else if (err instanceof Error) {
        errorMessage = `Error listing notes: ${err.message}`;
      }
      this.addMessage(`{red-fg}${errorMessage}{/red-fg}`);
      this.setStatus(` {bold}Status:{/bold} {red-fg}Error listing notes{/red-fg}`);
    }
  }
}
