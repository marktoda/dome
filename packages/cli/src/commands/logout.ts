import { Command } from 'commander';
import { clearApiKey, isAuthenticated } from '../utils/config';
import { success, error, info } from '../utils/ui';

/**
 * Register the logout command
 * @param program The commander program
 */
export function logoutCommand(program: Command): void {
  program
    .command('logout')
    .description('Log out from the dome API')
    .action(() => {
      try {
        // Check if authenticated
        if (!isAuthenticated()) {
          console.log(info('You are not logged in.'));
          return;
        }

        // Clear API key
        clearApiKey();

        console.log(success('Successfully logged out.'));
      } catch (err) {
        console.log(
          error(`Failed to log out: ${err instanceof Error ? err.message : String(err)}`),
        );
        process.exit(1);
      }
    });
}
