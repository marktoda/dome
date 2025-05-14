import { CommandHandler } from '../core/types';
import { getApiClient } from '../../utils/apiClient';
import { DomeApi, DomeApiError, DomeApiTimeoutError } from '@dome/dome-sdk';

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
      const apiClient = await getApiClient();
      // TUI search might have different defaults for limit, or pass args for category etc.
      // For now, using a default limit.
      const searchRequest: DomeApi.GetSearchRequest = { q: query, limit: 5 };
      const searchResponse: DomeApi.SearchResponse = await apiClient.search.searchContent(searchRequest);

      // Display results
      if (!searchResponse.success || !searchResponse.results || searchResponse.results.length === 0) {
        const message = searchResponse.message || `No results found for query: "${query}"`;
        this.addMessage(`{yellow-fg}${message}{/yellow-fg}`);
      } else {
        const totalResults = searchResponse.pagination?.total || searchResponse.results.length;
        this.addMessage(`{green-fg}Found ${totalResults} results (showing up to ${searchResponse.results.length}):{/green-fg}`);

        searchResponse.results.forEach((match: DomeApi.SearchResultItem, index: number) => {
          this.addMessage(
            `\n{bold}Result ${index + 1} (Score: ${match.score?.toFixed(2) || 'N/A'}){/bold}`,
          );
          this.addMessage(`{bold}ID:{/bold} ${match.id}`);
          this.addMessage(`{bold}Title:{/bold} ${match.title}`);
          this.addMessage(`{bold}Category:{/bold} ${match.category}`);
          this.addMessage(`{bold}MIME Type:{/bold} ${match.mimeType}`);
          if (match.summary) {
            this.addMessage(`{bold}Summary:{/bold} ${match.summary.substring(0, 100)}${match.summary.length > 100 ? '...' : ''}`);
          }
          this.addMessage(`{bold}Created:{/bold} ${new Date(match.createdAt).toLocaleString()}`);
          if (match.updatedAt) {
            this.addMessage(`{bold}Updated:{/bold} ${new Date(match.updatedAt).toLocaleString()}`);
          }
          this.addMessage('{gray-fg}' + '-'.repeat(50) + '{/gray-fg}');
        });

        if (searchResponse.pagination && searchResponse.pagination.hasMore) {
          this.addMessage(
            `\n{gray-fg}More results available. Total: ${searchResponse.pagination.total}. Use 'search' command with --limit for more.{/gray-fg}`,
          );
        }
      }
    } catch (err: unknown) {
      let errorMessage = 'Error searching.';
      if (err instanceof DomeApiError) {
        const apiError = err as DomeApiError;
        errorMessage = `API Error: ${apiError.message} (Status: ${apiError.statusCode || 'N/A'})`;
      } else if (err instanceof DomeApiTimeoutError) {
        const timeoutError = err as DomeApiTimeoutError;
        errorMessage = `API Timeout Error: ${timeoutError.message}`;
      } else if (err instanceof Error) {
        errorMessage = `Error searching: ${err.message}`;
      }
      this.addMessage(`{red-fg}${errorMessage}{/red-fg}`);
    }
  }
}
