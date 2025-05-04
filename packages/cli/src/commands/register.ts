import { Command } from 'commander';
import { registerUser, saveAuthToken } from '../utils/auth';
import { success, error, info } from '../utils/ui';
import readline from 'readline';
import { isAuthenticated } from '../utils/config';

/**
 * Register the register command
 * @param program The commander program
 */
export function registerCommand(program: Command): void {
  program
    .command('register')
    .description('Register a new user with the dome API')
    .option('-e, --email <email>', 'Email address')
    .option('-p, --password <password>', 'Password')
    .option('-n, --name <name>', 'Full name')
    .action(async (options: { email?: string; password?: string; name?: string }) => {
      try {
        // Check if already authenticated
        if (isAuthenticated()) {
          console.log(
            info('You are already logged in. To register a new account, run `dome logout` first.'),
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
              resolve(answer.trim());
            });
          });
        }

        // Prompt for name if not provided
        let name = options.name;
        if (!name) {
          name = await new Promise<string>(resolve => {
            rl.question('Enter your full name: ', answer => {
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
        if (!name) {
          console.log(error('Name is required.'));
          process.exit(1);
        }

        // Register the user
        console.log(info('Registering user...'));
        const result = await registerUser(email, password, name);

        if (result.success) {
          // Save token and show success message
          saveAuthToken(result);
          console.log(success('Registration successful. You are now logged in.'));

          // Show user info
          if (result.user) {
            console.log(info(`User: ${result.user.name} (${result.user.email})`));
          }
        } else {
          // Show error message
          console.log(error(`Registration failed: ${result.error?.message || 'Unknown error'}`));
          process.exit(1);
        }
      } catch (err) {
        console.log(
          error(`Registration failed: ${err instanceof Error ? err.message : String(err)}`),
        );
        process.exit(1);
      }
    });
}
