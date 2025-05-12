import { Command } from 'commander';
import { isAuthenticated, saveApiKey, saveUserId } from '../utils/config';
import { getApiClient, clearApiClientInstance } from '../utils/apiClient';
import { success, error, info } from '../utils/ui';
import { DomeApi, DomeApiError, DomeApiTimeoutError } from '@dome/dome-sdk'; // Updated import path
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
        const apiClient = getApiClient();
        // The SDK methods return the response body directly on success, or throw an error.
        const result: DomeApi.LoginResponse = await apiClient.auth.userLogin({ email, password });

        // Save token and show success message
        if (result.token) {
          saveApiKey(result.token);
          // Clear any cached API client that might have been initialized without a token
          clearApiClientInstance();
          console.log(success('Login successful. You can now use the dome CLI.'));

          // Fetch and display user info
          try {
            // Get a new API client instance that will use the saved token
            const newApiClient = getApiClient(); // This client will use the new token
            const validationResponse: DomeApi.ValidateTokenResponse = await newApiClient.auth.validateAuthenticationToken();
            if (validationResponse.success && validationResponse.user) {
              // Save userId to config
              saveUserId(validationResponse.user.id);
              console.log(info(`User: ${validationResponse.user.name} (${validationResponse.user.email}) - ID: ${validationResponse.user.id}`));
            } else {
              console.log(error('Could not retrieve user details after login. Chat functionality might be affected.'));
            }
          } catch (validationErr) {
            console.log(error('Login was successful, but failed to retrieve user details. Chat functionality might be affected.'));
            // Optionally log validationErr if needed for debugging, but don't fail the login
          }

        } else {
          // This case should ideally not be reached if the API guarantees a token on successful login.
          // If it can happen, the LoginResponse type should mark token as optional.
          console.log(error('Login failed: No token received despite successful response.'));
          process.exit(1);
        }
      } catch (err: unknown) {
        let errorMessage = 'An unknown error occurred during login.';
        if (err instanceof DomeApiError) {
          // Handle specific API errors from the SDK
          errorMessage = `Login failed: ${err.message} (Status: ${err.statusCode})`;
          if (err.body) {
            // Try to get a more specific message from the error body
            const errorBody = err.body as any;
            if (errorBody && errorBody.error && typeof errorBody.error.message === 'string') {
              errorMessage = `Login failed: ${errorBody.error.message} (Status: ${err.statusCode})`;
            } else if (typeof err.body === 'string') {
              errorMessage = `Login failed: ${err.body} (Status: ${err.statusCode})`;
            }
          }
        } else if (err instanceof DomeApiTimeoutError) {
          errorMessage = `Login failed: The request timed out. ${err.message}`;
        } else if (err instanceof Error) {
          errorMessage = `Login failed: ${err.message}`;
        }
        console.log(error(errorMessage));
        process.exit(1);
      }
    });
}
