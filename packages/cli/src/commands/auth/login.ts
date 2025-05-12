import { BaseCommand, CommandArgs } from '../base';
import { isAuthenticated, saveApiKey, saveUserId } from '../../utils/config';
import { getApiClient, clearApiClientInstance } from '../../utils/apiClient';
import { DomeApi } from '@dome/dome-sdk';
import readline from 'readline';
import { OutputFormat } from '../../utils/errorHandler';
import { Command } from 'commander'; // Added import

export class LoginCommand extends BaseCommand {
  constructor() {
    super('login', 'Login to the Dome API');
  }

  static register(program: Command): void {
    const cmd = program.command('login')
      .description('Login to the Dome API')
      .option('-e, --email <email>', 'Email address')
      .option('-p, --password <password>', 'Password')
      .option('--output-format <format>', 'Output format (cli, json), e.g., json or cli');
    
    cmd.action(async (optionsFromCommander) => {
      const commandInstance = new LoginCommand();
      // Commander's options are directly compatible with CommandArgs structure here
      await commandInstance.executeRun(optionsFromCommander as CommandArgs);
    });
  }

  async run(args: CommandArgs): Promise<void> {
    const outputFormat = args.outputFormat || OutputFormat.CLI;
    try {
      if (isAuthenticated()) {
        this.log('You are already logged in. To use a different API key, run `dome logout` first.', outputFormat);
        return;
      }

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const email = args.email || (await new Promise<string>(resolve => {
        rl.question('Enter your email: ', answer => resolve(answer.trim()));
      }));

      const password = args.password || (await new Promise<string>(resolve => {
        rl.question('Enter your password: ', answer => {
          // It's important to close the readline interface only once.
          // If email was provided but password wasn't, rl might be closed prematurely.
          // This logic ensures it's closed after the last prompt.
          if (!args.email || !args.password) {
            rl.close();
          }
          resolve(answer.trim());
        });
      }));
      
      // If both email and password were provided as args, rl was never used for prompting, close it.
      if (args.email && args.password) {
        rl.close();
      }


      if (!email) {
        this.error('Email is required.', { outputFormat });
        process.exitCode = 1;
        return;
      }
      if (!password) {
        this.error('Password is required.', { outputFormat });
        process.exitCode = 1;
        return;
      }

      this.log('Logging in...', outputFormat);
      const apiClient = getApiClient();
      const result: DomeApi.LoginResponse = await apiClient.auth.userLogin({ email, password });

      if (result.token) {
        this.log(`CLI LOGIN: Received token: ${result.token}`, outputFormat); // DEBUG LOG
        saveApiKey(result.token);
        clearApiClientInstance();
        this.log('Login successful. You can now use the dome CLI.', outputFormat);

        try {
          const newApiClient = getApiClient();
          const validationResponse: DomeApi.ValidateTokenResponse = await newApiClient.auth.validateAuthenticationToken();
          if (validationResponse.success && validationResponse.user) {
            saveUserId(validationResponse.user.id);
            this.log(`User: ${validationResponse.user.name} (${validationResponse.user.email}) - ID: ${validationResponse.user.id}`, outputFormat);
          } else {
            this.error('Could not retrieve user details after login. Chat functionality might be affected.', { outputFormat });
          }
        } catch (validationErr) {
          this.error('Login was successful, but failed to retrieve user details. Chat functionality might be affected.', { outputFormat });
        }
      } else {
        this.error('Login failed: No token received despite successful response.', { outputFormat });
        process.exitCode = 1;
      }
    } catch (err: unknown) {
      this.error(err, { outputFormat });
      process.exitCode = 1;
    }
  }
}

// Remove old main test function if commander is the primary way to run
// async function main() {
//   const command = new LoginCommand();
//   await command.execute(process.argv.slice(2));
// }

// if (require.main === module) {
//   main();
// }
