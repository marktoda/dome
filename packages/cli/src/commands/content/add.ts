import { BaseCommand, CommandArgs } from '../base';
import { isAuthenticated } from '../../utils/config';
import { getApiClient } from '../../utils/apiClient';
import { OutputFormat } from '../../utils/errorHandler';
import { DomeApi } from '@dome/dome-sdk';
import { Command } from 'commander';
import fs from 'fs';
import path from 'path';

export class AddCommand extends BaseCommand {
  constructor() {
    super('add', 'Add new content to dome (text or file path)');
  }

  static register(program: Command): void {
    const cmd = program
      .command('add')
      .description('Add new content to dome (text or file path)')
      .argument('<content>', 'Content to add (text or file path)')
      .option('--title <title>', 'Optional title for the content')
      .option('--category <category>', 'Optional category for the content')
      .option('--output-format <format>', 'Output format (cli, json)');

    cmd.action(async (contentValue: string, optionsFromCommander: any) => {
      const commandInstance = new AddCommand();
      const combinedArgs: CommandArgs = {
        ...optionsFromCommander,
        content: contentValue,
      };
      await commandInstance.executeRun(combinedArgs);
    });
  }

  async run(args: CommandArgs): Promise<void> {
    const outputFormat = args.outputFormat || OutputFormat.CLI;
    const contentArg = args.content as string;
    const titleArg = args.title as string | undefined;
    const categoryArg = args.category as string | undefined;

    if (!isAuthenticated()) {
      this.error('You need to login first. Run `dome login` to authenticate.', { outputFormat });
      process.exitCode = 1;
      return;
    }

    if (!contentArg) {
      this.error('Content argument is required.', { outputFormat });
      process.exitCode = 1;
      return;
    }

    try {
      let contentToAdd = contentArg;
      let title = titleArg;

      if (fs.existsSync(contentArg) && fs.statSync(contentArg).isFile()) {
        const fileName = path.basename(contentArg);
        this.log(`Adding file: ${fileName}...`, outputFormat);
        contentToAdd = fs.readFileSync(contentArg, 'utf-8');
        if (!title) {
          // Use filename as title if no title provided
          title = fileName;
        }
      } else {
        const contentPreview =
          contentArg.length > 40 ? `${contentArg.substring(0, 40)}...` : contentArg;
        this.log(`Adding text: "${contentPreview}"...`, outputFormat);
      }

      const apiClient = await getApiClient();
      const ingestPayload: {
        content: string;
        title?: string;
        category?: DomeApi.IngestNoteBodyApiSchemaCategory | undefined;
      } = {
        content: contentToAdd,
      };
      if (title) {
        ingestPayload.title = title;
      }
      if (categoryArg) {
        // Assuming categoryArg is a string compatible with IngestNoteBodyApiSchemaCategory (e.g., matches an enum value)
        ingestPayload.category = categoryArg as DomeApi.IngestNoteBodyApiSchemaCategory;
      }

      // Using ingestANewNote, assuming it's the generic endpoint.
      // Adjust if a different SDK method is more appropriate.
      await apiClient.notes.ingestANewNote(ingestPayload);

      this.log('Content successfully added to dome.', outputFormat);
    } catch (err) {
      // BaseCommand's executeRun will catch this
      throw err;
    }
  }
}
