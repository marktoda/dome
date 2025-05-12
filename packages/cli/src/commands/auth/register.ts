import { BaseCommand, CommandArgs } from '../base';
import { isAuthenticated, saveApiKey, saveUserId } from '../../utils/config';
import { getApiClient, clearApiClientInstance } from '../../utils/apiClient';
import { DomeApi } from '@dome/dome-sdk';
import readline from 'readline';
import { OutputFormat } from '../../utils/errorHandler';
import { Command } from 'commander';

export class RegisterCommand extends BaseCommand {
  constructor() {
    super('register', 'Register a new user with the Dome API');
  }

  static register(program: Command): void {
    const cmd = program.command('register')
      .description('Register a new user with the Dome API')
      .option('-e, --email <email>', 'Email address')
      .option('-p, --password <password>', 'Password')
      .option('-n, --name <name>', 'Full name')
      .option('--output-format <format>', 'Output format (cli, json)');
    
    cmd.action(async (optionsFromCommander) => {
      const commandInstance = new RegisterCommand();
      await commandInstance.executeRun(optionsFromCommander as CommandArgs);
    });
  }

  async run(args: CommandArgs): Promise<void> {
    const outputFormat = args.outputFormat || OutputFormat.CLI;

    if (isAuthenticated()) {
      this.log('You are already logged in. To register a new account, run `dome logout` first.', outputFormat);
      return;
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      const email = args.email || (await new Promise<string>(resolve => {
        rl.question('Enter your email: ', answer => resolve(answer.trim()));
      }));

      const password = args.password || (await new Promise<string>(resolve => {
        rl.question('Enter your password: ', answer => resolve(answer.trim()));
      }));
      
      const name = args.name || (await new Promise<string>(resolve => {
        rl.question('Enter your full name: ', answer => resolve(answer.trim()));
      }));

      // Close readline if all prompts were done.
      // If any arg was provided, one or more prompts might not have run.
      // This ensures rl is closed if it was used.
      if (!args.email || !args.password || !args.name) {
        rl.close();
      } else {
        // if all args provided, rl was not used for prompting, so close it.
        rl.close();
      }
      
      if (!email) {
        this.error('Email is required.', { outputFormat });
        process.exitCode = 1; // BaseCommand's executeRun will set this, but good for clarity
        return;
      }
      if (!password) {
        this.error('Password is required.', { outputFormat });
        process.exitCode = 1;
        return;
      }
      if (!name) {
        this.error('Name is required.', { outputFormat });
        process.exitCode = 1;
        return;
      }

      this.log('Registering user...', outputFormat);
      const apiClient = getApiClient();
      const result: DomeApi.RegisterResponse = await apiClient.auth.userRegistration({
        email,
        password,
        name,
      });

      if (result.token) {
        this.log(`CLI REGISTER: Received token: ${result.token}`, outputFormat); // DEBUG LOG
        saveApiKey(result.token);
        clearApiClientInstance();
        this.log('Registration successful. You are now logged in.', outputFormat);

        try {
          const newApiClient = getApiClient();
          const validationResponse: DomeApi.ValidateTokenResponse =
            await newApiClient.auth.validateAuthenticationToken();
          if (validationResponse.success && validationResponse.user) {
            saveUserId(validationResponse.user.id);
            this.log(
              `User: ${validationResponse.user.name} (${validationResponse.user.email}) - ID: ${validationResponse.user.id}`,
              outputFormat
            );
          } else {
            this.error('Could not retrieve user details after registration. Chat functionality might be affected.', { outputFormat });
          }
        } catch (validationErr) {
          this.error('Registration was successful, but failed to retrieve user details. Chat functionality might be affected.', { outputFormat });
        }
      } else {
        // This case implies the API response for successful registration *might* not have a token,
        // which would be unusual. The error handler in BaseCommand will catch if API throws.
        // If API returns success but no token, this is a specific logic error.
        this.error('Registration failed: No token received from server despite a successful response structure.', { outputFormat });
        process.exitCode = 1;
      }
    } catch (err) {
      // This catch is for readline errors or other unexpected issues before API call,
      // or if API call itself throws and is not caught by a more specific DomeApiError type check
      // within BaseCommand's executeRun. BaseCommand.executeRun should handle API errors.
      rl.close(); // Ensure readline is closed on error
      this.error(err, { outputFormat }); // Let BaseCommand handle formatting
      process.exitCode = 1; // executeRun in BaseCommand will also set this
    } finally {
        // Ensure readline is closed if not already. rl.close() is idempotent.
        rl.close();
    }
  }
}