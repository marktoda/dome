import { Command } from 'commander';
import { search } from '../utils/api';
import { createSpinner, error, heading, subheading, formatKeyValue } from '../utils/ui';
import { isAuthenticated } from '../utils/config';

/**
 * Register the search command
 * @param program The commander program
 */
export function searchCommand(program: Command): void {
  program
    .command('search')
    .description('Search across stored content')
    .argument('<query>', 'Search query')
    .option('-l, --limit <limit>', 'Maximum number of results to return', '10')
    .action(async (query: string, options: { limit: string }) => {
      // Check if user is authenticated
      if (!isAuthenticated()) {
        console.log(error('You need to login first. Run `dome login` to authenticate.'));
        process.exit(1);
      }

      try {
        const limit = parseInt(options.limit, 10);

        const spinner = createSpinner(`Searching for: ${query}`);
        spinner.start();

        const results = await search(query);

        spinner.stop();

        if (!results.results || results.results.length === 0) {
          console.log(`No results found for query: "${query}"`);
          return;
        }

        console.log(heading(`Search Results for: "${query}"`));
        console.log(`Found ${results.results.length} results.\n`);

        // Display results
        results.results.slice(0, limit).forEach((match: any, index: number) => {
          console.log(subheading(`Result ${index + 1} (Score: ${match.score.toFixed(2)})`));
          console.log(formatKeyValue('ID', match.id));
          console.log(formatKeyValue('Type', match.contentType || 'text/plain'));

          if (match.title) {
            console.log(formatKeyValue('Title', match.title));
          }

          if (match.tags && match.tags.length > 0) {
            console.log(formatKeyValue('Tags', match.tags.join(', ')));
          }

          console.log(formatKeyValue('Created', new Date(match.createdAt).toLocaleString()));

          // Display content body
          if (match.body) {
            console.log('\nContent:');
            // Limit the content to a reasonable length for display
            const maxLength = 200;
            const content = match.body.length > maxLength
              ? match.body.substring(0, maxLength) + '...'
              : match.body;
            console.log(content);
          }

          console.log('\n' + '-'.repeat(50) + '\n');
        });

        // Show message if results were limited
        if (results.results.length > limit) {
          console.log(
            `Showing ${limit} of ${results.results.length} results. Use --limit option to see more.`,
          );
        }
      } catch (err) {
        console.log(error(`Failed to search: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });
}
