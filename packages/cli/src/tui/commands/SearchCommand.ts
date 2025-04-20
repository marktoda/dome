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
  constructor(addMessage: (message: string) => void, setStatus: (status: string) => void) {
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
        const totalResults = results.pagination?.total || results.results.length;
        this.addMessage(`{green-fg}Found ${totalResults} results:{/green-fg}`);

        // Display results
        results.results.slice(0, 5).forEach((match: any, index: number) => {
          this.addMessage(
            `\n{bold}Result ${index + 1} (Score: ${match.score?.toFixed(2) || 'N/A'}){/bold}`,
          );
          if (match.title) {
            this.addMessage(`{bold}Title:{/bold} ${match.title}`);
          }
          if (match.contentType) {
            this.addMessage(`{bold}Type:{/bold} ${match.contentType}`);
          }

          // Try to extract tags from metadata if available
          let tags: string[] = [];
          if (match.metadata) {
            try {
              const metadata =
                typeof match.metadata === 'string' ? JSON.parse(match.metadata) : match.metadata;

              if (metadata.tags && Array.isArray(metadata.tags)) {
                tags = metadata.tags;
              }
            } catch (e) {
              // Ignore parsing errors
            }
          }

          if (tags.length > 0) {
            this.addMessage(`{bold}Tags:{/bold} ${tags.join(', ')}`);
          }

          this.addMessage(`{bold}Created:{/bold} ${new Date(match.createdAt).toLocaleString()}`);

          // Display content excerpt - use body field from new API
          if (match.body) {
            const excerpt =
              match.body.length > 200 ? match.body.substring(0, 200) + '...' : match.body;

            this.addMessage('\n{bold}Excerpt:{/bold}');
            this.addMessage(excerpt);
          }

          this.addMessage('{gray-fg}' + '-'.repeat(50) + '{/gray-fg}');
        });

        // Show message if results were limited
        if (results.pagination && results.pagination.hasMore) {
          this.addMessage(
            `\n{gray-fg}Showing 5 of ${totalResults} results. Use the search command for more details.{/gray-fg}`,
          );
        }
      }
    } catch (err) {
      this.addMessage(
        `{red-fg}Error searching: ${err instanceof Error ? err.message : String(err)}{/red-fg}`,
      );
    }
  }
}
