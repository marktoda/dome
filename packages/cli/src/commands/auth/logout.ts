import { BaseCommand, CommandArgs } from '../base';
import { clearApiKey, isAuthenticated } from '../../utils/config';
import { getApiClient, clearApiClientInstance } from '../../utils/apiClient';
// DomeApiError and DomeApiTimeoutError are not directly used in run, but error handler in BaseCommand might use them.
// import { DomeApiError, DomeApiTimeoutError } from '@dome/dome-sdk';
import { OutputFormat } from '../../utils/errorHandler';
import { Command } from 'commander'; // Added import

export class LogoutCommand extends BaseCommand {
  constructor() {
    super('logout', 'Log out from the Dome API');
  }

  static register(program: Command): void {
    const cmd = program
      .command('logout')
      .description('Log out from the Dome API')
      .option('--output-format <format>', 'Output format (cli, json)');

    cmd.action(async optionsFromCommander => {
      const commandInstance = new LogoutCommand();
      await commandInstance.executeRun(optionsFromCommander as CommandArgs);
    });
  }

  async run(args: CommandArgs): Promise<void> {
    const outputFormat = args.outputFormat || OutputFormat.CLI;
    try {
      if (!isAuthenticated()) {
        this.log('You are not logged in.', outputFormat);
        return;
      }

      let attemptedServerLogout = false;
      try {
        const apiClient = await getApiClient();
        attemptedServerLogout = true;
        const logoutResult = await apiClient.auth.userLogout();
        if (logoutResult.success) {
          this.log('Successfully logged out from server.', outputFormat);
        } else if (logoutResult.message) {
          this.log(`Server logout: ${logoutResult.message}`, outputFormat);
        }
      } catch (serverLogoutError: unknown) {
        if (attemptedServerLogout) {
          // We reached the server but the call failed – log and continue.
          this.error(serverLogoutError, { outputFormat });
          this.log('Continuing with local logout.', outputFormat);
        } else {
          // Failed before contacting server (likely due to expired tokens).
          this.log('Session already expired. Performing local logout.', outputFormat);
        }
      }

      clearApiKey();
      clearApiClientInstance();

      this.log('Successfully logged out locally.', outputFormat);
    } catch (err: unknown) {
      // This catch block is for unexpected errors in the main logout command logic itself
      this.error(err, { outputFormat });
      process.exitCode = 1;
    }
  }
}

// Remove old main test function
// async function main() {
//   const command = new LogoutCommand();
//   await command.execute(process.argv.slice(2));
// }

// if (require.main === module) {
//   main();
// }
