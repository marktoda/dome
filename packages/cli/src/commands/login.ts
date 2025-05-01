import { Command } from 'commander';
import { saveApiKey, isAuthenticated } from '../utils/config';
import { success, error, info } from '../utils/ui';
import readline from 'readline';

/**
 * Register the login command
 * @param program The commander program
 */
export function loginCommand(program: Command): void {
  program
    .command('login')
    .description('Authenticate with the dome API using a Bearer token')
    .option('-k, --key <key>', 'Authentication token (if not provided, will prompt for it)')
    .action(async (options: { key?: string }) => {
      try {
        // Check if already authenticated
        if (isAuthenticated()) {
          console.log(
            info('You are already logged in. To use a different API key, run `dome logout` first.'),
          );
          return;
        }

        let apiKey = options.key;

        // If API key is not provided, prompt for it
        if (!apiKey) {
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });

          apiKey = await new Promise<string>(resolve => {
            rl.question('Enter your authentication token: ', answer => {
              rl.close();
              resolve(answer.trim());
            });
          });
        }

        // Validate API key
        if (!apiKey) {
          console.log(error('Authentication token is required.'));
          process.exit(1);
        }

        // Save API key
        saveApiKey(apiKey);

        console.log(success('Successfully authenticated with Bearer token. You can now use the dome CLI.'));
      } catch (err) {
        console.log(
          error(`Failed to authenticate: ${err instanceof Error ? err.message : String(err)}`),
        );
        process.exit(1);
      }
    });
}
