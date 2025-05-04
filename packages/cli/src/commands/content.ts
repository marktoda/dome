import { Command } from 'commander';
import { registerGithubRepo } from '../utils/api';
import { error, info, success } from '../utils/ui';
import { isAuthenticated } from '../utils/config';

/**
 * Register the content command
 * @param program The commander program
 */
export function contentCommand(program: Command): void {
  const contentCmd = program.command('content').description('Manage content in Dome');

  // Add a GitHub repository
  contentCmd
    .command('add')
    .description('Add content to Dome')
    .addCommand(
      new Command('github')
        .description('Add a GitHub repository to Dome')
        .argument('<owner/repo>', 'GitHub repository in the format owner/repo')
        .option('-c, --cadence <cadence>', 'Sync cadence (e.g., PT1H for hourly)', 'PT1H')
        .action(async (repoArg, options) => {
          // Check if user is authenticated
          if (!isAuthenticated()) {
            console.log(error('You need to login first. Run `dome login` to authenticate.'));
            process.exit(1);
          }

          try {
            // Parse owner/repo format
            const [owner, repo] = repoArg.split('/');
            if (!owner || !repo) {
              console.log(error('Invalid repository format. Use "owner/repo" format.'));
              process.exit(1);
            }

            console.log(info(`Registering GitHub repository: ${owner}/${repo}`));
            console.log(info(`Sync cadence: ${options.cadence}`));

            const result = await registerGithubRepo(owner, repo, options.cadence);

            if (result.success) {
              console.log(success(`Repository ${owner}/${repo} registered successfully!`));
              console.log(info(`Sync plan ID: ${result.id}`));
              console.log(info(`Resource ID: ${result.resourceId}`));
              console.log(
                info(`Repository ${result.wasInitialised ? 'was' : 'was not'} newly initialized.`),
              );
            } else {
              console.log(error('Failed to register repository.'));
              console.log(error(JSON.stringify(result, null, 2)));
            }
          } catch (err) {
            console.log(error('An error occurred while registering the repository:'));
            console.log(error(err instanceof Error ? err.message : String(err)));
            process.exit(1);
          }
        }),
    );
}
