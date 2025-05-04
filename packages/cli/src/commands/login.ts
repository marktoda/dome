import { Command } from 'commander';
import { isAuthenticated } from '../utils/config';
import { loginUser, saveAuthToken } from '../utils/auth';
import { success, error, info } from '../utils/ui';
import readline from 'readline';

/**
 * Register the login command
 * @param program The commander program
 */
export function loginCommand(program: Command): void {
  program
    .command('login')
    .description('Login to the dome API')
    .option('-e, --email <email>', 'Email address')
    .option('-p, --password <password>', 'Password')
    .action(async (options: { email?: string; password?: string }) => {
      try {
        // Check if already authenticated
        if (isAuthenticated()) {
          console.log(
            info('You are already logged in. To use a different API key, run `dome logout` first.'),
          );
          return;
        }

        // Create readline interface
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        // Prompt for email if not provided
        let email = options.email;
        if (!email) {
          email = await new Promise<string>(resolve => {
            rl.question('Enter your email: ', answer => {
              resolve(answer.trim());
            });
          });
        }

        // Prompt for password if not provided
        let password = options.password;
        if (!password) {
          password = await new Promise<string>(resolve => {
            // Use stdin with echo off for password input would be better in a real app
            rl.question('Enter your password: ', answer => {
              rl.close();
              resolve(answer.trim());
            });
          });
        } else {
          rl.close();
        }

        // Validate required fields
        if (!email) {
          console.log(error('Email is required.'));
          process.exit(1);
        }
        if (!password) {
          console.log(error('Password is required.'));
          process.exit(1);
        }

        // Login the user
        console.log(info('Logging in...'));
        const result = await loginUser(email, password);

        if (result.success) {
          // Save token and show success message
          saveAuthToken(result);
          console.log(success('Login successful. You can now use the dome CLI.'));

          // Show user info if available
          if (result.user) {
            console.log(info(`User: ${result.user.name} (${result.user.email})`));
          }
        } else {
          // Show error message
          console.log(error(`Login failed: ${result.error?.message || 'Invalid credentials'}`));
          process.exit(1);
        }
      } catch (err) {
        console.log(
          error(`Failed to authenticate: ${err instanceof Error ? err.message : String(err)}`),
        );
        process.exit(1);
      }
    });
}
