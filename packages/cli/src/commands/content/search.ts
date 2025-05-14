import { BaseCommand, CommandArgs } from '../base';
import { isAuthenticated } from '../../utils/config';
import { getApiClient } from '../../utils/apiClient';
import { DomeApi } from '@dome/dome-sdk'; // DomeApiError, DomeApiTimeoutError removed
import { OutputFormat } from '../../utils/errorHandler';
import { Command } from 'commander'; // Added import
// Assuming ui utilities are still relevant or will be adapted/replaced
import { heading, subheading, formatKeyValue } from '../../utils/ui';
// import { createSpinner } from '../../utils/ui'; // If using spinner

export class SearchCommand extends BaseCommand {
  constructor() {
    super('search', 'Search across all stored content types');
  }

  static register(program: Command): void {
    const cmd = program.command('search')
      .description('Search across all stored content types')
      .argument('<query>', 'Search query')
      .option('-l, --limit <limit>', 'Maximum number of results to return', '10') // Default value for option
      .option('-c, --category <category>', 'Filter results by content type (e.g., code, docs, notes)')
      .option('--output-format <format>', 'Output format (cli, json)');
    
    cmd.action(async (queryValue: string, optionsFromCommander: any) => {
      const commandInstance = new SearchCommand();
      const combinedArgs: CommandArgs = {
        ...optionsFromCommander,
        query: queryValue, // Add the positional argument
      };
      await commandInstance.executeRun(combinedArgs);
    });
  }

  // The parseArguments method is no longer called in the commander flow.
  // public parseArguments(rawArgs: string[]): CommandArgs { ... }

  async run(args: CommandArgs): Promise<void> {
    const outputFormat = args.outputFormat || OutputFormat.CLI;
    const query = args.query as string; // query is now directly from CommandArgs
    const limitOption = args.limit as string | undefined; // Commander provides this as string if set
    const category = args.category as string | undefined;

    if (!isAuthenticated()) {
      this.error('You need to login first. Run `dome login` to authenticate.', { outputFormat });
      process.exitCode = 1;
      return;
    }

    if (!query) {
        this.error('Search query is required. e.g., `dome search "my query"`', { outputFormat });
        process.exitCode = 1;
        return;
    }

    const limit = limitOption ? parseInt(limitOption, 10) : 10;

    try {
      const searchMessage = category
        ? `Searching for: "${query}" in category: ${category}`
        : `Searching for: "${query}"`;
      
      // const spinner = createSpinner(searchMessage); // If using spinner
      // spinner.start();
      this.log(searchMessage + "...", outputFormat);

      const apiClient = await getApiClient();
      const searchRequest: DomeApi.GetSearchRequest = {
        q: query,
        limit,
      };
      if (category) {
        searchRequest.category = category;
      }

      const searchResponse: DomeApi.SearchResponse = await apiClient.search.searchContent(searchRequest);
      // spinner.stop(); // If using spinner

      if (outputFormat === OutputFormat.JSON) {
        console.log(JSON.stringify(searchResponse, null, 2));
        return;
      }

      // CLI Output
      if (!searchResponse.success || !searchResponse.results || searchResponse.results.length === 0) {
        const message = searchResponse.message || `No results found for query: "${query}"`;
        this.log(message, outputFormat);
        return;
      }

      const headerText = category
        ? `Search Results for: "${query}" (Category: ${category})`
        : `Search Results for: "${query}"`;

      console.log(heading(headerText)); // Using ui utility
      this.log(`Found ${searchResponse.results.length} results for query: "${searchResponse.query}"`, outputFormat);
      if (searchResponse.pagination) {
          const { total, limit: respLimit, offset, hasMore } = searchResponse.pagination;
          this.log(`Total results: ${total}, Showing: ${searchResponse.results.length} (Limit: ${respLimit}, Offset: ${offset}), Has more: ${hasMore}`, outputFormat);
      }
      console.log('');


      searchResponse.results.forEach((match: DomeApi.SearchResultItem, index: number) => {
        const score = typeof match.score === 'number' ? match.score : 0;
        console.log(subheading(`Result ${index + 1} (Score: ${score.toFixed(2)})`)); // ui utility
        console.log(formatKeyValue('ID', match.id)); // ui utility
        console.log(formatKeyValue('Title', match.title));
        console.log(formatKeyValue('Category', match.category));
        console.log(formatKeyValue('MIME Type', match.mimeType));
        console.log(formatKeyValue('Summary', match.summary));
        console.log(formatKeyValue('Created', new Date(match.createdAt).toLocaleString()));
        if (match.updatedAt) {
          console.log(formatKeyValue('Updated', new Date(match.updatedAt).toLocaleString()));
        }

        if (match.body) {
          console.log('\nContent Snippet:');
          const maxLength = 200;
          const contentBody =
            match.body.length > maxLength
              ? match.body.substring(0, maxLength) + '...'
              : match.body;
          console.log(contentBody);
        }
        console.log('\n' + '-'.repeat(50) + '\n');
      });

    } catch (err: unknown) {
      this.error(err, { outputFormat });
      process.exitCode = 1;
    }
  }
}

// Remove old main test function
// async function main() {
//   const command = new SearchCommand();
//   await command.execute(process.argv.slice(2));
// }

// if (require.main === module) {
//   main();
// }