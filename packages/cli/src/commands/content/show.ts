import { BaseCommand, CommandArgs } from '../base';
import { isAuthenticated } from '../../utils/config';
import { getApiClient } from '../../utils/apiClient';
import { DomeApi, DomeApiError } from '@dome/dome-sdk'; // DomeApiTimeoutError not directly used in new logic
import { OutputFormat } from '../../utils/errorHandler';
import { Command } from 'commander';
// Assuming ui utilities are still desired
import { heading, subheading, formatKeyValue, formatDate } from '../../utils/ui';

export class ShowCommand extends BaseCommand {
  constructor() {
    super('show', 'Show details of a specific note');
  }

  static register(program: Command): void {
    const cmd = program
      .command('show')
      .description('Show details of a specific note')
      .argument('<id>', 'ID of the note to show')
      .argument('[type]', 'Type of item to show (currently only "note" is supported)', 'note')
      .option('--output-format <format>', 'Output format (cli, json)');

    cmd.action(async (idValue: string, typeValue: string, optionsFromCommander: any) => {
      const commandInstance = new ShowCommand();
      const combinedArgs: CommandArgs = {
        ...optionsFromCommander,
        id: idValue,
        type: typeValue,
      };
      await commandInstance.executeRun(combinedArgs);
    });
  }

  async run(args: CommandArgs): Promise<void> {
    const outputFormat = args.outputFormat || OutputFormat.CLI;
    const id = args.id as string;
    const type = (args.type as string) || 'note';

    if (!isAuthenticated()) {
      this.error('You need to login first. Run `dome login` to authenticate.', { outputFormat });
      process.exitCode = 1;
      return;
    }

    if (type !== 'note') {
      this.error(
        'Invalid type. Currently, only "note" is supported for showing details.\nExample: dome show <note_id>',
        { outputFormat },
      );
      process.exitCode = 1;
      return;
    }

    this.log(`Fetching note with ID: ${id}...`, outputFormat);

    try {
      const apiClient = await getApiClient();
      const note: DomeApi.Note = await apiClient.notes.getANoteById(id);

      if (outputFormat === OutputFormat.JSON) {
        console.log(JSON.stringify(note, null, 2));
        return;
      }

      // CLI Output
      console.log(heading('Note Details'));
      console.log(formatKeyValue('ID', note.id));
      console.log(formatKeyValue('Title', note.title || '(No title)'));
      console.log(formatKeyValue('Category', note.category || '(No category)'));
      console.log(formatKeyValue('MIME Type', note.mimeType));
      console.log(formatKeyValue('Size (bytes)', note.size.toString()));
      console.log(formatKeyValue('Created', formatDate(new Date(note.createdAt))));
      if (note.url) {
        console.log(formatKeyValue('URL (for large content)', note.url));
      }
      if (note.customMetadata && Object.keys(note.customMetadata).length > 0) {
        console.log(subheading('Custom Metadata'));
        for (const key in note.customMetadata) {
          console.log(formatKeyValue(`  ${key}`, String(note.customMetadata[key])));
        }
      }
      console.log(subheading('Content'));
      console.log(note.content || '(No content)');
    } catch (err) {
      if (err instanceof DomeApiError && err.statusCode === 404) {
        this.error(`Note with ID "${id}" not found.`, { outputFormat });
        process.exitCode = 1; // Set exit code for not found
      } else {
        // For other errors, let BaseCommand's executeRun handle it
        throw err;
      }
    }
  }
}
