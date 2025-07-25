import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs/promises';
import inquirer from 'inquirer';
import matter from 'gray-matter';
import { z } from 'zod';
import { editorManager } from '../services/editor-manager.js';
import { openai } from '@ai-sdk/openai';
import { generateObject } from 'ai';
import { toRel, toAbs } from '../../mastra/utils/path-utils.js';
import { mkdir } from 'node:fs/promises';
import { config } from '../../mastra/core/config.js';
import logger from '../../mastra/utils/logger.js';
import { ContextManager } from '../../mastra/core/context/manager.js';
import { promptWithCleanTerminal } from '../utils/prompt-helper.js';

const contextSchema = z.object({
  name: z.string(),
  description: z.string(),
  template: z
    .object({
      frontmatter: z.record(z.string(), z.string()).optional(),
      content: z.string().optional(),
    })
    .optional(),
  rules: z.string(),
  instructions: z.string(),
});

type Context = z.infer<typeof contextSchema>;

async function createFolder(): Promise<void> {
  try {
    // First, prompt for the folder path
    const { folderPath } = await promptWithCleanTerminal<{ folderPath: string }>([
      {
        type: 'input',
        name: 'folderPath',
        message: 'Enter the folder path (relative to vault root or absolute):',
        validate: (input: string) => {
          if (input.trim().length === 0) {
            return 'Folder path is required';
          }
          // Check for invalid characters in path
          if (input.includes('..')) {
            return 'Path cannot contain ".."';
          }
          return true;
        },
      },
    ]);

    const relFolder = toRel(folderPath);
    const fullPath = toAbs(relFolder);

    // Ensure the folder structure exists
    await mkdir(fullPath, { recursive: true });

    // Check if .dome file already exists
    const domePath = path.join(fullPath, '.dome');
    try {
      await fs.access(domePath);
      logger.warn('A .dome file already exists in this folder.');
      
      const { overwrite } = await promptWithCleanTerminal<{ overwrite: boolean }>([
        {
          type: 'confirm',
          name: 'overwrite',
          message: 'Do you want to overwrite it?',
          default: false,
        },
      ]);
      
      if (!overwrite) {
        logger.info('Folder creation cancelled.');
        return;
      }
    } catch {
      // .dome file doesn't exist, continue
    }
    const folderName = path.basename(fullPath);

    // Prompt for folder context information
    const answers = await promptWithCleanTerminal<{ description: string; addRules: string }>([
      {
        type: 'input',
        name: 'description',
        message: 'Describe the purpose of this folder and of notes it will contain:',
        validate: (input: string) => input.trim().length > 0 || 'Description is required',
      },
      {
        type: 'input',
        name: 'addRules',
        message:
          'Please describe any formatting rules for documents in this folder. i.e. file naming conventions, text templates, metadata fields, etc. [Empty for none]',
      },
    ]);

    // Generate context using AI
    logger.info('🤖 Generating context file using AI...');

    const prompt = `Create a comprehensive context file for a folder with the following specifications:

Folder Name: ${folderName}
Purpose: ${answers.description}
${answers.addRules ? `Additional Rules: ${answers.addRules}` : ''}

Generate a well-structured context that includes:
1. A clear, descriptive name
2. A comprehensive description
3. Appropriate template with frontmatter fields and content structure
4. Relevant rules (file naming, required fields, auto-tags)
5. AI instructions for working with notes in this folder

The context should be specific, practical, and help maintain consistency for all notes in this folder.`;

    try {
      const { object: context } = await generateObject<Context>({
        model: openai('gpt-4o-mini'),
        schema: contextSchema,
        prompt,
      });

      // Create the .dome file
      const fileContent = matter.stringify('', context as object);
      await fs.writeFile(domePath, fileContent);

      logger.info(`✅ Successfully created folder context at: ${fullPath}`);
      logger.info(`📝 .dome file created with:`);
      logger.info(`   Name: ${context.name}`);
      logger.info(`   Description: ${context.description}`);
      logger.info(`   template: ${context.template?.frontmatter}\n ${context.template?.content}`);
      logger.info(`   Rules: ${context.rules}`);
    } catch (aiError) {
      logger.error('❌ Error generating context with AI:', aiError);
      throw aiError;
    }
  } catch (error) {
    logger.error('❌ Error creating folder:', error);
    process.exit(1);
  }
}

async function editFolder(folderPath?: string): Promise<void> {
  try {
    let targetPath: string;

    if (folderPath) {
      targetPath = path.isAbsolute(folderPath)
        ? folderPath
        : path.join(config.DOME_VAULT_PATH, folderPath);
    } else {
      // If no path provided, find all .dome files
      const domeFiles = await findDomeFiles(config.DOME_VAULT_PATH);

      if (domeFiles.length === 0) {
        logger.warn('⚠️  No .dome files found in the vault.');
        return;
      }

      const { selected } = await promptWithCleanTerminal<{ selected: string }>([
        {
          type: 'list',
          name: 'selected',
          message: 'Select a folder context to edit:',
          choices: domeFiles.map(file => ({
            name: `${path.dirname(file.replace(config.DOME_VAULT_PATH + '/', ''))} - ${file}`,
            value: file,
          })),
        },
      ]);

      targetPath = path.dirname(selected);
    }

    const domePath = path.join(targetPath, '.dome');

    // Check if .dome file exists
    try {
      await fs.access(domePath);
    } catch {
      logger.warn(`⚠️  No .dome file found at: ${targetPath}`);
      const { create } = await promptWithCleanTerminal<{ create: boolean }>([
        {
          type: 'confirm',
          name: 'create',
          message: 'Would you like to create one?',
          default: true,
        },
      ]);
      
      if (create) {
        await createFolder();
      }
      return;
    }

    // Open the file in the default editor
    logger.info(`📝 Opening .dome file in your editor...`);
    const success = await editorManager.openEditor({
      path: domePath.replace(config.DOME_VAULT_PATH + '/', ''),
      isNew: false,
    });

    if (!success) {
      logger.error('❌ Failed to open file in editor');
      process.exit(1);
    } else {
      logger.info('✅ Successfully edited .dome file');
      process.exit(0);
    }
  } catch (error) {
    logger.error('❌ Error editing folder:', error);
    process.exit(1);
  }
}

async function findDomeFiles(dir: string, files: string[] = []): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        await findDomeFiles(fullPath, files);
      } else if (entry.isFile() && entry.name === '.dome') {
        files.push(fullPath);
      }
    }
  } catch (error) {
    // Ignore permission errors
  }

  return files;
}

async function listFolders(): Promise<void> {
  try {
    const manager = new ContextManager();
    const contexts = await manager.listContexts();

    if (contexts.length === 0) {
      logger.info('📭 No folder contexts (.dome) found in the vault.');
      return;
    }

    logger.info(`\n📂 Found ${contexts.length} folder context${contexts.length !== 1 ? 's' : ''}:\n`);

    for (const ctx of contexts) {
      logger.info(` • ${ctx.path || '/'}${ctx.context && ctx.context.trim() === '' ? ' (empty)' : ''}`);
    }
  } catch (error) {
    logger.error('❌ Failed to list folders:', error);
    process.exit(1);
  }
}

async function showContext(folderName: string): Promise<void> {
  try {
    const folderPath = path.isAbsolute(folderName)
      ? folderName
      : path.join(config.DOME_VAULT_PATH, folderName);

    const manager = new ContextManager();
    const context = await manager.loadContext(folderPath);

    if (context === null) {
      logger.warn(`⚠️  No .dome context found for folder: ${folderName}`);
      return;
    }

    logger.info(`\n📄 Context for ${folderName}:\n`);
    logger.info(context);
  } catch (error) {
    logger.error('❌ Failed to load folder context:', error);
    process.exit(1);
  }
}

export function createFolderCommand(): Command {
  const folderCommand = new Command('folder').description(
    'Manage folder contexts with .dome files'
  );

  folderCommand
    .command('new')
    .description('Create a new folder with a .dome context file')
    .action(createFolder);

  folderCommand
    .command('edit [path]')
    .description('Edit an existing .dome context file')
    .action(editFolder);

  folderCommand
    .command('list')
    .description('List all folders that contain a .dome context file')
    .action(listFolders);

  folderCommand
    .command('context <folder>')
    .description('Show the context for a specific folder')
    .action(showContext);

  return folderCommand;
}
