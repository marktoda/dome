import { CommandHandler } from '../core/types';
import { search } from '../../utils/api';

/**
 * Search command for searching content
 */
export class SearchCommand implements CommandHandler {
  private addMessage: (message: string) => void;
  private setStatus: (status: string) => void;

  /**
   * Create a new search command
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
    return 'search';
  }

  /**
   * Get command description
   */
  getDescription(): string {
    return 'Search for content';
  }

  /**
   * Handle command
   * @param args Command arguments
   */
  async handle(args: string[]): Promise<void> {
    if (args.length === 0) {
      this.addMessage('{red-fg}Error: Missing query. Usage: /search <query>{/red-fg}');
      return;
    }

    const query = args.join(' ');
    this.addMessage(`{bold}Searching for:{/bold} ${query}`);

    try {
      this.setStatus(' {bold}Status:{/bold} Searching...');
      
      // Perform search using the API
      const results = await search(query);

      // Display results
      if (!results.results || results.results.length === 0) {
        this.addMessage(`{yellow-fg}No results found for query: "${query}"{/yellow-fg}`);
      } else {
        this.addMessage(`{green-fg}Found ${results.results.length} results:{/green-fg}`);

        // Display results
        results.results.slice(0, 5).forEach((match: any, index: number) => {
          this.addMessage(
            `\n{bold}Result ${index + 1} (Score: ${match.score?.toFixed(2) || 'N/A'}){/bold}`
          );
          if (match.title) {
            this.addMessage(`{bold}Title:{/bold} ${match.title}`);
          }
          if (match.type) {
            this.addMessage(`{bold}Type:{/bold} ${match.type}`);
          }
          if (match.tags && match.tags.length > 0) {
            this.addMessage(`{bold}Tags:{/bold} ${match.tags.join(', ')}`);
          }
          this.addMessage(`{bold}Created:{/bold} ${new Date(match.createdAt).toLocaleString()}`);

          // Display content excerpt
          if (match.excerpt) {
            this.addMessage('\n{bold}Excerpt:{/bold}');
            this.addMessage(match.excerpt);
          }

          this.addMessage('{gray-fg}' + '-'.repeat(50) + '{/gray-fg}');
        });

        // Show message if results were limited
        if (results.results.length > 5) {
          this.addMessage(
            `\n{gray-fg}Showing 5 of ${results.results.length} results. Use the search command for more details.{/gray-fg}`
          );
        }
      }
    } catch (err) {
      this.addMessage(
        `{red-fg}Error searching: ${
          err instanceof Error ? err.message : String(err)
        }{/red-fg}`
      );
    }
  }
}