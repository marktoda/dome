import { BaseCommand, CommandArgs } from '../base';
import { isAuthenticated } from '../../utils/config';
import { getApiClient } from '../../utils/apiClient';
import { DomeApi, DomeApiError } from '@dome/dome-sdk';
import { OutputFormat } from '../../utils/errorHandler';
import { Command } from 'commander';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
// Assuming ui utilities are still desired
import { heading, subheading, formatKeyValue, formatDate } from '../../utils/ui';


export class UpdateContentCommand extends BaseCommand {
  constructor() {
    super('update', 'Update existing content in Dome using an editor');
  }

  static register(program: Command): void {
    const cmd = program.command('update')
      .description('Update existing content in Dome using an editor')
      .argument('<contentId>', 'ID of the content (note) to update')
      // .argument('[type]', 'Type of item (currently "note")', 'note') // Type is fixed to note for now
      .option('--output-format <format>', 'Output format (cli, json)');
    
    cmd.action(async (contentIdValue: string, optionsFromCommander: any) => {
      const commandInstance = new UpdateContentCommand();
      const combinedArgs: CommandArgs = {
        ...optionsFromCommander,
        contentId: contentIdValue,
        // type: typeValue, // If type argument is re-added
      };
      await commandInstance.executeRun(combinedArgs);
    });
  }

  async run(args: CommandArgs): Promise<void> {
    const outputFormat = args.outputFormat || OutputFormat.CLI;
    const contentId = args.contentId as string;
    // const type = args.type as string || 'note'; // If type argument is used

    if (!isAuthenticated()) {
      this.error('You need to login first. Run `dome login` to authenticate.', { outputFormat });
      process.exitCode = 1;
      return;
    }

    // if (type !== 'note') { // If type argument is used
    //   this.error('Currently, only "note" type content can be updated this way.', { outputFormat });
    //   process.exitCode = 1;
    //   return;
    // }

    if (!contentId) {
        this.error('Content ID is required.', { outputFormat });
        process.exitCode = 1;
        return;
    }
    
    let tempFilePath = '';

    try {
      this.log(`Fetching content with ID: ${contentId} for update...`, outputFormat);
      const apiClient = getApiClient();
      let noteToUpdate: DomeApi.Note;
      try {
          noteToUpdate = await apiClient.notes.getANoteById(contentId);
      } catch (fetchErr) {
          if (fetchErr instanceof DomeApiError && fetchErr.statusCode === 404) {
            this.error(`Note with ID ${contentId} not found.`, { outputFormat });
          } else {
            this.error(`Failed to fetch note: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`, { outputFormat });
          }
          process.exitCode = 1;
          return;
      }

      tempFilePath = path.join(os.tmpdir(), `dome-content-${Date.now()}-${noteToUpdate.id}.md`);
      const originalContent = noteToUpdate.content || '';
      const filePreamble = [
        `---`,
        `id: ${noteToUpdate.id}`,
        `title: ${noteToUpdate.title || 'Untitled Content'}`,
        `category: ${noteToUpdate.category || ''}`,
        `created_at: ${noteToUpdate.createdAt}`,
        // `updated_at` removed as it's not on DomeApi.Note
        `---`,
        ``,
        `<!-- Edit content below this line. Save and close editor to update. -->`,
        `<!-- Title and category can be edited in the frontmatter above. -->`,
        ``,
      ].join('\n');
      
      fs.writeFileSync(tempFilePath, filePreamble + originalContent);

      this.log(`Opening content in your editor (${process.env.EDITOR || 'default editor'})...`, outputFormat);
      this.log('The CLI will continue when you exit the editor.', outputFormat);

      try {
        execSync(`${process.env.EDITOR || 'vi'} "${tempFilePath}"`, { stdio: 'inherit', env: process.env });
      } catch (editorError) {
        this.error(`Editor closed with an error or failed to open: ${editorError instanceof Error ? editorError.message : String(editorError)}`, { outputFormat });
        // Do not exit here, allow cleanup
      }
      
      const updatedFileContent = fs.readFileSync(tempFilePath, 'utf8');
      
      // Basic frontmatter and content parsing
      const parts = updatedFileContent.split(/---\s*([\s\S]*?)\s*---/s);
      const newContentBody = (parts.length === 3 ? parts[2] : updatedFileContent).trim();
      // TODO: Parse title/category from frontmatter if changed. For now, only content update.

      if (newContentBody === originalContent.trim()) {
        this.log('Content not changed. No update performed.', outputFormat);
        return;
      }

      // SDK currently lacks a direct update. Placeholder for delete + ingest or future update method.
      this.log('Simulating update (SDK lacks direct update): Deleting old and ingesting new.', outputFormat);
      
      // 1. (Optional but safer) Ingest new first with a temporary category/flag if possible
      // For simplicity, we'll show the concept of delete then add.
      // In a real scenario, consider transactionality or soft delete.

      const newTitle = noteToUpdate.title; // For now, title/category not updated from editor
      const newCategory = noteToUpdate.category as DomeApi.IngestNoteBodyApiSchemaCategory | undefined;

      await apiClient.notes.ingestANewNote({
          title: newTitle,
          content: newContentBody,
          category: newCategory,
          // customMetadata: { ...(noteToUpdate.customMetadata || {}), originalId: contentId } // Example to link if creating new
      });
      this.log('New version of content ingested.', outputFormat);

      // 2. Delete old note (if new one was successfully ingested)
      // await apiClient.notes.deleteANote(contentId); // Assuming deleteANote(id: string) exists
      // this.log(`Old note ${contentId} marked for deletion (if new version was successful).`, outputFormat);
      this.log(`NOTE: Original note ${contentId} was NOT deleted. Manual cleanup may be needed until full update is supported.`, outputFormat);


      this.log('Content update process finished (simulated).', outputFormat);

    } catch (err) {
      // BaseCommand's executeRun will catch this
      throw err;
    } finally {
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        try {
          fs.unlinkSync(tempFilePath);
        } catch (cleanupErr) {
          this.error(`Failed to clean up temporary file ${tempFilePath}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`, { outputFormat });
        }
      }
    }
  }
}