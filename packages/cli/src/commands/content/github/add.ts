import { BaseCommand, CommandArgs } from '../../base';
import { isAuthenticated } from '../../../utils/config';
import { getApiClient } from '../../../utils/apiClient';
import { DomeApi } from '@dome/dome-sdk';
import { OutputFormat } from '../../../utils/errorHandler';
import { Command } from 'commander';

export class AddGitHubRepoCommand extends BaseCommand {
  constructor() {
    super('add', 'Add a GitHub repository to Dome');
  }

  static register(program: Command): void {
    const cmd = program.command('add')
      .description('Add a GitHub repository to Dome')
      .argument('<repository>', 'GitHub repository in the format owner/repo')
      .option('-c, --cadence <cadence>', 'Sync cadence (e.g., PT1H for hourly)', 'PT1H') // Default from original
      .option('--output-format <format>', 'Output format (cli, json)');
    
    cmd.action(async (repoArg: string, optionsFromCommander: any) => {
      const commandInstance = new AddGitHubRepoCommand();
      const combinedArgs: CommandArgs = {
        ...optionsFromCommander,
        repository: repoArg, // Argument name from .argument()
      };
      await commandInstance.executeRun(combinedArgs);
    });
  }

  async run(args: CommandArgs): Promise<void> {
    const outputFormat = args.outputFormat || OutputFormat.CLI;
    const repoArg = args.repository as string;
    const cadence = args.cadence as string; // Will be default 'PT1H' if not provided

    if (!isAuthenticated()) {
      this.error('You need to login first. Run `dome login` to authenticate.', { outputFormat });
      process.exitCode = 1;
      return;
    }

    if (!repoArg) {
        this.error('Repository argument (owner/repo) is required.', { outputFormat });
        process.exitCode = 1;
        return;
    }

    const [owner, repo] = repoArg.split('/');
    if (!owner || !repo) {
      this.error('Invalid repository format. Use "owner/repo" format.', { outputFormat });
      process.exitCode = 1;
      return;
    }

    try {
      this.log(`Registering GitHub repository: ${owner}/${repo}...`, outputFormat);
      if (outputFormat === OutputFormat.CLI) { // Only log cadence for CLI for brevity
        this.log(`Sync cadence: ${cadence}`, outputFormat);
      }
      
      // Note about cadence from original command
      if (cadence !== 'PT1H' && outputFormat === OutputFormat.CLI) {
        this.log(`Note: Custom sync cadence ('${cadence}') might not be fully supported by the current SDK version for setting. Default server cadence may apply.`, outputFormat);
      }

      const apiClient = getApiClient();
      const result: DomeApi.GithubRepoResponse = await apiClient.contentGitHub.registerGitHubRepository({ owner, repo });
      
      if (outputFormat === OutputFormat.JSON) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        this.log(`Repository ${result.owner}/${result.name} registered successfully!`, outputFormat);
        this.log(`ID: ${result.id}`, outputFormat);
      }

    } catch (err) {
      // BaseCommand's executeRun will catch this
      throw err;
    }
  }
}