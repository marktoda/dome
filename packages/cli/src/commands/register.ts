import { Command } from 'commander';
import { success, error, info } from '../utils/ui';
import readline from 'readline';
import { isAuthenticated, saveApiKey, saveUserId } from '../utils/config';
import { getApiClient, clearApiClientInstance } from '../utils/apiClient';
import { DomeApi, DomeApiError, DomeApiTimeoutError } from '@dome/dome-sdk';

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
        const apiClient = getApiClient();
        const result: DomeApi.RegisterResponse = await apiClient.auth.userRegistration({
          email,
          password,
          name,
        });

        if (result.token) {
          console.log(`CLI REGISTER: Received token: ${result.token}`); // DEBUG LOG
          saveApiKey(result.token);
          clearApiClientInstance(); // Ensure next apiClient call uses the new token
          console.log(success('Registration successful. You are now logged in.'));

          // Fetch and display user info
          try {
            const newApiClient = getApiClient(); // Gets client with the new token
            const validationResponse: DomeApi.ValidateTokenResponse =
              await newApiClient.auth.validateAuthenticationToken();
            if (validationResponse.success && validationResponse.user) {
              saveUserId(validationResponse.user.id); // Save userId
              console.log(
                info(`User: ${validationResponse.user.name} (${validationResponse.user.email}) - ID: ${validationResponse.user.id}`),
              );
            } else {
              console.log(error('Could not retrieve user details after registration. Chat functionality might be affected.'));
            }
          } catch (validationErr) {
            console.log(error('Registration was successful, but failed to retrieve user details. Chat functionality might be affected.'));
          }
        } else {
          console.log(error('Registration failed: No token received.'));
          process.exit(1);
        }
      } catch (err: unknown) {
        let errorMessage = 'An unknown error occurred during registration.';
        if (err instanceof DomeApiError) {
          const apiError = err as DomeApiError;
          const status = apiError.statusCode ?? 'N/A';
          let detailMessage = apiError.message;
          // Check if body exists and has a more specific message
          if (apiError.body && typeof apiError.body === 'object' && apiError.body !== null) {
            const body = apiError.body as any; // Cast to any to check for common error structures
            if (body.error && typeof body.error.message === 'string') {
              detailMessage = body.error.message;
            } else if (typeof body.message === 'string') { // Sometimes error is directly in body.message
              detailMessage = body.message;
            } else if (typeof apiError.body === 'string') { // If body is just a string
                detailMessage = apiError.body;
            }
          }
          errorMessage = `Registration failed: ${detailMessage} (Status: ${status})`;
        } else if (err instanceof DomeApiTimeoutError) {
          const timeoutError = err as DomeApiTimeoutError;
          errorMessage = `Registration failed: The request timed out. ${timeoutError.message}`;
        } else if (err instanceof Error) {
          errorMessage = `Registration failed: ${err.message}`;
        }
        console.log(error(errorMessage));
        process.exit(1);
      }
    });
}
