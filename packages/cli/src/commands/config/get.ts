import { BaseCommand, CommandArgs } from '../base';
import { getConfigStore } from '../../utils/config';
import { formatKeyValue } from '../../utils/ui'; // error, info from ui are replaced by BaseCommand methods
import { OutputFormat } from '../../utils/errorHandler';
import { Command } from 'commander';

export class GetConfigCommand extends BaseCommand {
  constructor() {
    super('get', 'Get configuration values');
  }

  static register(program: Command): void {
    const cmd = program
      .command('get')
      .description('Get configuration values')
      .option('-k, --key <key>', 'Specific configuration key to get')
      .option('--output-format <format>', 'Output format (cli, json)');

    cmd.action(async optionsFromCommander => {
      const commandInstance = new GetConfigCommand();
      await commandInstance.executeRun(optionsFromCommander as CommandArgs);
    });
  }

  async run(args: CommandArgs): Promise<void> {
    const outputFormat = args.outputFormat || OutputFormat.CLI;
    const keyToGet = args.key as string | undefined;

    try {
      const config = getConfigStore();

      if (outputFormat === OutputFormat.JSON) {
        let output: any = config.store;
        if (keyToGet) {
          if (config.has(keyToGet)) {
            output = { [keyToGet]: config.get(keyToGet) };
          } else {
            this.error(`Configuration key "${keyToGet}" not found.`, { outputFormat });
            process.exitCode = 1;
            return;
          }
        }
        // Mask API key in JSON output as well
        if (output.apiKey) {
          output.apiKey = '********';
        }
        console.log(JSON.stringify(output, null, 2));
        return;
      }

      // CLI Output
      if (keyToGet) {
        const value = config.get(keyToGet);
        if (value === undefined) {
          this.error(`Configuration key "${keyToGet}" not found.`, { outputFormat });
          process.exitCode = 1;
          return;
        }
        this.log(formatKeyValue(keyToGet, JSON.stringify(value)), outputFormat);
      } else {
        const allConfig = config.store;
        this.log('Current Configuration:', outputFormat);
        Object.entries(allConfig).forEach(([key, value]) => {
          if (key === 'apiKey' && value) {
            this.log(formatKeyValue(key, '********'), outputFormat);
          } else {
            this.log(formatKeyValue(key, JSON.stringify(value)), outputFormat);
          }
        });
      }
    } catch (err) {
      // BaseCommand's executeRun will catch this and use this.error
      throw err;
    }
  }
}
