import { Command } from 'commander';
import { error, info, success } from '../utils/ui';
import { isAuthenticated } from '../utils/config';
import { getApiClient } from '../utils/apiClient';
import { DomeApi, DomeApiError, DomeApiTimeoutError } from '@dome/dome-sdk';
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

  // Add content to Dome (general command)
  contentCmd
    .command('add')
    .description('Add content to Dome')
    .argument('[content]', 'Content to add (text, file path, or URL)')
    .action(async (content: string) => {
      // Check if user is authenticated
      if (!isAuthenticated()) {
        console.log(error('You need to login first. Run `dome login` to authenticate.'));
        process.exit(1);
      }

      try {
        // Check if content is a file path
        if (fs.existsSync(content) && fs.statSync(content).isFile()) {
          const fileName = path.basename(content);
          console.log(info(`Adding file: ${fileName}`));

          // Read file content
          const fileContent = fs.readFileSync(content, 'utf-8');

          // Add file content
          const apiClient = getApiClient();
          await apiClient.notes.ingestANewNote({
            content: fileContent,
            title: fileName, // Use filename as title
            // category: 'file', // Optional: set a category
          });
          console.log(success(`Added file: ${fileName}`));
        } else {
          // Add text content
          const apiClient = getApiClient();
          const contentPreview = content.length > 40 ? `${content.substring(0, 40)}...` : content;
          console.log(info(`Adding: "${contentPreview}"`));

          await apiClient.notes.ingestANewNote({ content });
          console.log(success('Added to dome'));
        }
      } catch (err: unknown) {
        let errorMessage = 'Failed to add content.';
        if (err instanceof DomeApiError) {
          const apiError = err as DomeApiError;
          const status = apiError.statusCode ?? 'N/A';
          let detailMessage = apiError.message;
          if (apiError.body && typeof apiError.body === 'object' && apiError.body !== null && 'message' in apiError.body && typeof (apiError.body as any).message === 'string') {
            detailMessage = (apiError.body as { message: string }).message;
          }
          errorMessage = `Error adding content: ${detailMessage} (Status: ${status})`;
        } else if (err instanceof DomeApiTimeoutError) {
          const timeoutError = err as DomeApiTimeoutError;
          errorMessage = `Error adding content: Request timed out. ${timeoutError.message}`;
        } else if (err instanceof Error) {
          errorMessage = `Error adding content: ${err.message}`;
        }
        console.log(error(errorMessage));
        process.exit(1);
      }
    });

  // Add GitHub commands
  const githubCmd = contentCmd.command('github').description('Manage GitHub repositories in Dome');

  // Add GitHub repository
  githubCmd
    .command('add')
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

        const apiClient = getApiClient();
        // Cadence option is not supported by the SDK's registerGitHubRepository method directly
        if (options.cadence !== 'PT1H') { // PT1H is the old default
            console.log(info(`Note: Custom sync cadence ('${options.cadence}') is not directly settable via this SDK version. Default server cadence will be used.`));
        }
        const result: DomeApi.GithubRepoResponse = await apiClient.contentGitHub.registerGitHubRepository({ owner, repo });

        console.log(success(`Repository ${result.owner}/${result.name} registered successfully!`));
        console.log(info(`ID: ${result.id}`));
        // resourceId and wasInitialised are not available in SDK response
        
      } catch (err: unknown) {
        let errorMessage = 'An error occurred while registering the repository.';
        if (err instanceof DomeApiError) {
          const apiError = err as DomeApiError;
          const status = apiError.statusCode ?? 'N/A';
          let detailMessage = apiError.message;
          if (apiError.body && typeof apiError.body === 'object' && apiError.body !== null && 'message' in apiError.body && typeof (apiError.body as any).message === 'string') {
            detailMessage = (apiError.body as { message: string }).message;
          }
          errorMessage = `Error registering repo: ${detailMessage} (Status: ${status})`;
        } else if (err instanceof DomeApiTimeoutError) {
          const timeoutError = err as DomeApiTimeoutError;
          errorMessage = `Error registering repo: Request timed out. ${timeoutError.message}`;
        } else if (err instanceof Error) {
          errorMessage = `Error registering repo: ${err.message}`;
        }
        console.log(error(errorMessage));
        process.exit(1);
      }
    });

  // Add update command
  contentCmd
    .command('update')
    .description('Update existing content in Dome')
    .argument('<contentId>', 'ID of the content to update')
    .action(async contentId => {
      // Check if user is authenticated
      if (!isAuthenticated()) {
        console.log(error('You need to login first. Run `dome login` to authenticate.'));
        process.exit(1);
      }

      try {
        // Fetch the content
        console.log(info(`Fetching content with ID: ${contentId}`));
        const apiClient = getApiClient();
        let noteToUpdate: DomeApi.Note;
        try {
            noteToUpdate = await apiClient.notes.getANoteById(contentId);
        } catch (fetchErr: unknown) {
            let fetchErrorMessage = `Failed to fetch note with ID ${contentId}.`;
            if (fetchErr instanceof DomeApiError) {
                const apiFetchError = fetchErr as DomeApiError;
                if (apiFetchError.statusCode === 404) {
                    fetchErrorMessage = `Note with ID ${contentId} not found.`;
                } else {
                    fetchErrorMessage = `Error fetching note: ${apiFetchError.message} (Status: ${apiFetchError.statusCode || 'N/A'})`;
                }
            } else if (fetchErr instanceof DomeApiTimeoutError) {
                fetchErrorMessage = `Timeout fetching note: ${(fetchErr as DomeApiTimeoutError).message}`;
            } else if (fetchErr instanceof Error) {
                fetchErrorMessage = `Failed to fetch note: ${fetchErr.message}`;
            }
            console.log(error(fetchErrorMessage));
            process.exit(1);
        }


        // Create temp file with content
        const tempFilePath = path.join(os.tmpdir(), `dome-content-${Date.now()}.md`);

        // Format the content with metadata from DomeApi.Note
        const title = noteToUpdate.title || 'Untitled Content';
        const contentBody = noteToUpdate.content || '';
        const category = noteToUpdate.category || '';
        // Tags and summary are not directly available in DomeApi.Note, use category or customMetadata if applicable

        const fileContent = [
          `# ${title}`,
          `Category: ${category}`,
          // `Summary: ${summary}`, // Summary not directly available
          '',
          '<!-- Write your content below this line -->',
          '',
          contentBody,
        ].join('\n');

        // Log the content being written to the file

        fs.writeFileSync(tempFilePath, fileContent);

        // Open in editor
        console.log(
          info(`Opening content in your editor (${process.env.EDITOR || 'default editor'})...`),
        );
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
          // TODO: Implement update logic. The SDK does not currently have a direct 'updateNote' method.
          // This might involve deleting the old note and ingesting a new one,
          // or a specific API endpoint for updates if available.
          console.log(info('Update functionality for notes via SDK is pending.'));
          console.log(info('Updated title (local): ' + updatedTitle));
          console.log(info('Updated content (local): ' + updatedContentBody.substring(0, 50) + '...'));
          // console.log(info('Updated tags (local): ' + updatedTags.join(', ')));


          // const result = await updateContent( // This function is from the old API utils
          //   contentId,
          //   updatedContentBody,
          //   updatedTitle,
          //   updatedTags,
          // );

          // if (result) {
          //   console.log(success(`Content updated successfully!`));
          //   console.log(info(`Title: ${result.title || updatedTitle}`));
          //   console.log(info(`Content will be reprocessed automatically.`));
          // } else {
          //   console.log(error('Failed to update content.'));
          // }
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
      } catch (mainUpdateErr: unknown) { // Renamed to avoid conflict with inner err
        let updateErrorMessage = 'An error occurred while updating the content.';
        if (mainUpdateErr instanceof Error) { // Basic check for generic errors in the overall update process
            updateErrorMessage = mainUpdateErr.message;
        }
        // More specific error handling for DomeApiError etc. could be added here if main try block could throw them
        console.log(error(updateErrorMessage));
        process.exit(1);
      }
    });
}
