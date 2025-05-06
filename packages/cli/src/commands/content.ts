import { Command } from 'commander';
import { registerGithubRepo, showItem, updateContent } from '../utils/api';
import { error, info, success } from '../utils/ui';
import { isAuthenticated } from '../utils/config';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

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

  // Add update command
  contentCmd
    .command('update')
    .description('Update existing content in Dome')
    .argument('<contentId>', 'ID of the content to update')
    .action(async (contentId) => {
      // Check if user is authenticated
      if (!isAuthenticated()) {
        console.log(error('You need to login first. Run `dome login` to authenticate.'));
        process.exit(1);
      }

      try {
        // Fetch the content
        console.log(info(`Fetching content with ID: ${contentId}`));
        const content = await showItem(contentId);

        if (!content) {
          console.log(error(`Content with ID ${contentId} not found.`));
          process.exit(1);
        }

        // Create temp file with content
        const tempFilePath = path.join(os.tmpdir(), `dome-content-${Date.now()}.md`);

        // Format the content with metadata
        const title = content.title || 'Untitled Content';
        // Try different property names that might contain the content
        let contentBody = '';
        if (content.body) {
          contentBody = content.body;
        } else if (content.content) {
          contentBody = content.content;
        } else if (typeof content === 'string') {
          contentBody = content;
        } else if (content.text) {
          contentBody = content.text;
        } else {
          console.log(info('Content body not found in expected properties. Using empty string.'));
        }

        const tags = content.tags ? content.tags.join(', ') : '';
        const summary = content.summary || '';

        const fileContent = [
          `# ${title}`,
          `Tags: ${tags}`,
          summary ? `Summary: ${summary}` : '',
          '',
          '<!-- Write your content below this line -->',
          '',  // Add an extra blank line for clarity
          contentBody,
        ].join('\n');

        // Log the content being written to the file

        fs.writeFileSync(tempFilePath, fileContent);

        // Open in editor
        console.log(info(`Opening content in your editor (${process.env.EDITOR || 'default editor'})...`));
        console.log(info('The CLI will continue when you exit the editor.'));

        try {
          execSync(`${process.env.EDITOR || 'vi'} "${tempFilePath}"`, {
            stdio: 'inherit',
            env: process.env,
          });

          // Parse updated content
          const updatedContent = fs.readFileSync(tempFilePath, 'utf8');
          const lines = updatedContent.split('\n');

          let updatedTitle = 'Untitled Content';
          let updatedTags: string[] = [];
          let contentStartIndex = 0;

          // Parse metadata
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            if (i === 0 && line.startsWith('# ')) {
              updatedTitle = line.substring(2).trim();
              continue;
            }

            if (line.startsWith('Tags:')) {
              const tagsPart = line.substring(5).trim();
              if (tagsPart) {
                updatedTags = tagsPart.split(',').map(tag => tag.trim());
              }
              continue;
            }

            if (line.includes('<!-- Write your content below this line -->')) {
              contentStartIndex = i + 1;
              break;
            }

            // If we've gone through several lines without finding the marker,
            // assume content starts after a reasonable number of metadata lines
            if (i >= 5) {
              contentStartIndex = i;
              break;
            }
          }

          const updatedContentBody = lines.slice(contentStartIndex).join('\n').trim();

          // Clean up temp file
          try {
            fs.unlinkSync(tempFilePath);
          } catch (err) {
            // Ignore errors when deleting temp file
          }

          if (!updatedContentBody.trim()) {
            console.log(error('Content was empty, nothing updated.'));
            process.exit(1);
          }

          // Update the content
          const result = await updateContent(contentId, updatedContentBody, updatedTitle, updatedTags);

          if (result) {
            console.log(success(`Content updated successfully!`));
            console.log(info(`Title: ${result.title || updatedTitle}`));
            console.log(info(`Content will be reprocessed automatically.`));
          } else {
            console.log(error('Failed to update content.'));
          }
        } catch (err) {
          console.log(error('An error occurred while editing the content:'));
          console.log(error(err instanceof Error ? err.message : String(err)));

          // Clean up temp file
          try {
            fs.unlinkSync(tempFilePath);
          } catch (cleanupErr) {
            // Ignore errors when deleting temp file
          }

          process.exit(1);
        }
      } catch (err) {
        console.log(error('An error occurred while updating the content:'));
        console.log(error(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });
}
