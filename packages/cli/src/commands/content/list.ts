import { BaseCommand, CommandArgs } from '../base';
import { isAuthenticated } from '../../utils/config';
import { getApiClient } from '../../utils/apiClient';
import { DomeApi } from '@dome/dome-sdk';
import { OutputFormat } from '../../utils/errorHandler';
import { Command } from 'commander';
// Assuming formatTable and heading are still desired from ui utilities
import { formatTable, heading } from '../../utils/ui'; 
// createSpinner and other ui elements can be replaced by BaseCommand.log or simple console logs

export class ListCommand extends BaseCommand {
  constructor() {
    super('list', 'List notes');
  }

  static register(program: Command): void {
    const cmd = program.command('list')
      .description('List notes')
      .argument('[type]', 'Type of items to list (currently only "notes" is supported)', 'notes')
      .option('-c, --category <category>', 'Filter by category')
      .option('--limit <limit>', 'Number of notes to retrieve', '50')
      .option('--offset <offset>', 'Offset for pagination', '0')
      .option('--output-format <format>', 'Output format (cli, json)');
    
    cmd.action(async (typeValue: string, optionsFromCommander: any) => {
      const commandInstance = new ListCommand();
      const combinedArgs: CommandArgs = {
        ...optionsFromCommander,
        type: typeValue,
      };
      await commandInstance.executeRun(combinedArgs);
    });
  }

  async run(args: CommandArgs): Promise<void> {
    const outputFormat = args.outputFormat || OutputFormat.CLI;
    const type = args.type as string || 'notes';
    const category = args.category as string | undefined;
    const limit = parseInt(args.limit as string || '50', 10);
    const offset = parseInt(args.offset as string || '0', 10);

    if (!isAuthenticated()) {
      this.error('You need to login first. Run `dome login` to authenticate.', { outputFormat });
      process.exitCode = 1;
      return;
    }

    if (type !== 'notes') {
      this.error('Invalid type. Currently, only "notes" are supported for listing.\nExample: dome list notes --category "meetings"', { outputFormat });
      process.exitCode = 1;
      return;
    }

    try {
      this.log(`Listing notes${category ? ` (category: ${category})` : ''}...`, outputFormat);

      const apiClient = await getApiClient();
      const requestParams: DomeApi.GetNotesRequest = { limit, offset };
      if (category) {
        requestParams.category = category as DomeApi.GetNotesRequestCategory;
      }

      const notes: DomeApi.Note[] = await apiClient.notes.listNotes(requestParams);

      if (outputFormat === OutputFormat.JSON) {
        console.log(JSON.stringify(notes, null, 2));
        return;
      }

      // CLI Output
      if (!notes || notes.length === 0) {
        this.log(`No notes found${category ? ` in category "${category}"` : ''}.`, outputFormat);
        return;
      }
      
      this.log(`Showing ${notes.length} notes.`, outputFormat);
      console.log(heading('Notes')); // Using ui utility

      const headers = ['ID', 'Title', 'Category', 'Content Snippet', 'Created'];
      const rows = notes.map((note: DomeApi.Note) => {
        const content = note.content || '';
        const truncatedContent = content.length > 50 ? content.substring(0, 47) + '...' : content;
        return [
          note.id,
          note.title || '(No title)',
          note.category || '(No category)',
          truncatedContent,
          new Date(note.createdAt).toLocaleString(),
        ];
      });

      console.log(formatTable(headers, rows)); // Using ui utility
      
    } catch (err) {
      // BaseCommand's executeRun will catch this
      throw err;
    }
  }
}