import { BaseCommand, CommandArgs } from '../base';
import { setBaseUrl, setEnvironment } from '../../utils/config';
// success, info from ui are replaced by BaseCommand.log
// error from ui is replaced by BaseCommand.error
import { OutputFormat } from '../../utils/errorHandler';
import { Command } from 'commander';

export class SetConfigCommand extends BaseCommand {
  constructor() {
    super('set', 'Set configuration values');
  }

  static register(program: Command): void {
    const cmd = program.command('set')
      .description('Set configuration values')
      .option('-u, --base-url <url>', 'Set the base URL for the API')
      .option('-e, --environment <env>', 'Set the environment (development or production)')
      .option('--output-format <format>', 'Output format (cli, json)');
    
    cmd.action(async (optionsFromCommander) => {
      const commandInstance = new SetConfigCommand();
      await commandInstance.executeRun(optionsFromCommander as CommandArgs);
    });
  }

  async run(args: CommandArgs): Promise<void> {
    const outputFormat = args.outputFormat || OutputFormat.CLI;
    const baseUrl = args.baseUrl as string | undefined;
    const environment = args.environment as string | undefined;
    let changed = false;

    try {
      if (baseUrl) {
        try {
          new URL(baseUrl); // Validate URL
        } catch (err) {
          this.error('Invalid URL format.', { outputFormat });
          process.exitCode = 1;
          return;
        }
        setBaseUrl(baseUrl);
        this.log(`Base URL set to: ${baseUrl}`, outputFormat);
        changed = true;
      }

      if (environment) {
        if (environment !== 'development' && environment !== 'production') {
          this.error('Environment must be either "development" or "production".', { outputFormat });
          process.exitCode = 1;
          return;
        }
        setEnvironment(environment as 'development' | 'production');
        this.log(`Environment set to: ${environment}`, outputFormat);
        changed = true;
      }

      if (!changed) {
        this.log('No configuration changes specified. Use --base-url or --environment options.', outputFormat);
      }
    } catch (err) {
      // BaseCommand's executeRun will catch this
      throw err;
    }
  }
}