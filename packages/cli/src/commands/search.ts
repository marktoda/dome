import { Command } from 'commander';
import { createSpinner, error, heading, subheading, formatKeyValue } from '../utils/ui';
import { isAuthenticated } from '../utils/config';
import { getApiClient } from '../utils/apiClient';
import { DomeApi, DomeApiError, DomeApiTimeoutError } from '@dome/dome-sdk';

/**
 * Register the search command
 * This command searches across all content types, not just notes
 * @param program The commander program
 */
export function searchCommand(program: Command): void {
  program
    .command('search')
    .description('Search across all stored content types')
    .argument('<query>', 'Search query')
    .option('-l, --limit <limit>', 'Maximum number of results to return', '10')
    .option('-c, --category <category>', 'Filter results by content type (e.g., code, docs, notes)')
    .action(async (query: string, options: { limit: string; category?: string }) => {
      // Check if user is authenticated
      if (!isAuthenticated()) {
        console.log(error('You need to login first. Run `dome login` to authenticate.'));
        process.exit(1);
      }

      try {
        const limit = parseInt(options.limit, 10);
        const category = options.category;

        const searchMessage = category
          ? `Searching for: "${query}" in category: ${category}`
          : `Searching for: "${query}"`;

        const spinner = createSpinner(searchMessage);
        spinner.start();

        const apiClient = getApiClient();
        const searchRequest: DomeApi.GetSearchRequest = {
          q: query,
          limit,
        };
        if (category) {
          searchRequest.category = category;
        }

        const searchResponse: DomeApi.SearchResponse = await apiClient.search.searchContent(searchRequest);

        spinner.stop();

        if (!searchResponse.success || !searchResponse.results || searchResponse.results.length === 0) {
          const message = searchResponse.message || `No results found for query: "${query}"`;
          console.log(message);
          return;
        }

        const headerText = category
          ? `Search Results for: "${query}" (Category: ${category})`
          : `Search Results for: "${query}"`;

        console.log(heading(headerText));
        console.log(`Found ${searchResponse.results.length} results for query: "${searchResponse.query}"`);
        if (searchResponse.pagination) {
            const { total, limit, offset, hasMore } = searchResponse.pagination;
            console.log(`Total results: ${total}, Showing: ${searchResponse.results.length} (Limit: ${limit}, Offset: ${offset}), Has more: ${hasMore}`);
        }
        console.log('');


        // Display results
        searchResponse.results.forEach((match: DomeApi.SearchResultItem, index: number) => {
          const score = typeof match.score === 'number' ? match.score : 0;
          console.log(subheading(`Result ${index + 1} (Score: ${score.toFixed(2)})`));
          console.log(formatKeyValue('ID', match.id));
          console.log(formatKeyValue('Title', match.title));
          console.log(formatKeyValue('Category', match.category));
          console.log(formatKeyValue('MIME Type', match.mimeType));
          console.log(formatKeyValue('Summary', match.summary));
          console.log(formatKeyValue('Created', new Date(match.createdAt).toLocaleString()));
          if (match.updatedAt) {
            console.log(formatKeyValue('Updated', new Date(match.updatedAt).toLocaleString()));
          }


          // Display content body
          if (match.body) {
            console.log('\nContent Snippet:');
            const maxLength = 200;
            const content =
              match.body.length > maxLength
                ? match.body.substring(0, maxLength) + '...'
                : match.body;
            console.log(content);
          }

          console.log('\n' + '-'.repeat(50) + '\n');
        });
        
        // Pagination info is now part of searchResponse.pagination
        // The current CLI logic for "Showing X of Y results" might need adjustment
        // if we want to strictly adhere to the pagination object from the API.
        // For now, the message above `Found ${searchResponse.results.length} results` and pagination details cover this.

      } catch (err: unknown) {
        let errorMessage = 'Failed to search.';
        if (err instanceof DomeApiError) {
          const apiError = err as DomeApiError;
          const status = apiError.statusCode ?? 'N/A';
          let detailMessage = apiError.message;
          if (apiError.body && typeof apiError.body === 'object' && apiError.body !== null && 'message' in apiError.body && typeof (apiError.body as any).message === 'string') {
            detailMessage = (apiError.body as { message: string }).message;
          }
          errorMessage = `Search error: ${detailMessage} (Status: ${status})`;
        } else if (err instanceof DomeApiTimeoutError) {
          const timeoutError = err as DomeApiTimeoutError;
          errorMessage = `Search error: Request timed out. ${timeoutError.message}`;
        } else if (err instanceof Error) {
          errorMessage = `Search error: ${err.message}`;
        }
        console.log(error(errorMessage));
        process.exit(1);
      }
    });
}
