/**
 * Context management CLI commands for the Dome vault system.
 * Provides commands to create, list, and validate context configurations.
 */

import { Command } from 'commander';
import { ContextManager } from '../../mastra/core/context/manager.js';
import { getTemplate } from '../../mastra/core/context/templates.js';
import { join } from 'node:path';
import fs from 'node:fs/promises';
import { DomeError, FileOperationError, getErrorMessage } from '../../mastra/core/errors.js';

const vaultPath = process.env.DOME_VAULT_PATH ?? `${process.env.HOME}/dome`;

/**
 * Create the main context command with subcommands
 * @returns Commander command instance
 */
export function createContextCommand(): Command {
  const context = new Command('context');
  
  context
    .description('manage folder contexts')
    .addCommand(createContextCreateCommand())
    .addCommand(createContextListCommand())
    .addCommand(createContextValidateCommand());
  
  return context;
}

/**
 * Create subcommand for creating new contexts
 */
function createContextCreateCommand(): Command {
  const create = new Command('create');
  
  create
    .description('create a new context configuration')
    .argument('<folder>', 'folder path (relative to vault)')
    .option('-t, --template <template>', 'use a template (meetings, journal, projects, ideas, reading)')
    .option('-n, --name <name>', 'context name')
    .option('-d, --description <description>', 'context description')
    .action(async (folder: string, options: any) => {
      await handleCreateContext(folder, options);
    });
  
  return create;
}

/**
 * Create subcommand for listing contexts
 */
function createContextListCommand(): Command {
  const list = new Command('list');
  
  list
    .description('list all contexts in the vault')
    .option('--json', 'output as JSON')
    .action(async (options: any) => {
      await handleListContexts(options);
    });
  
  return list;
}

/**
 * Create subcommand for validating notes
 */
function createContextValidateCommand(): Command {
  const validate = new Command('validate');
  
  validate
    .description('validate a note against its context rules')
    .argument('<path>', 'note path (relative to vault)')
    .action(async (notePath: string) => {
      await handleValidateNote(notePath);
    });
  
  return validate;
}

/**
 * Handle context creation
 */
async function handleCreateContext(folder: string, options: any): Promise<void> {
  const manager = new ContextManager(vaultPath);
  const folderPath = join(vaultPath, folder);
  
  try {
    // Ensure folder exists
    await fs.mkdir(folderPath, { recursive: true });
    
    if (options.template) {
      // Use template
      const template = await getTemplate(options.template);
      if (!template) {
        console.error(`❌ Template '${options.template}' not found`);
        console.error('Available templates: meetings, journal, projects, ideas, reading');
        process.exit(1);
      }
      
      await manager.createContext(folderPath, template.context);
      console.log(`✅ Created ${template.name} context in ${folder}/`);
    } else {
      // Create custom context
      if (!options.name || !options.description) {
        console.error('❌ For custom contexts, both --name and --description are required');
        process.exit(1);
      }
      
      const context = {
        name: options.name,
        description: options.description,
        template: {
          frontmatter: {},
          content: `# {title}\n\n`,
        },
        rules: {
          fileNaming: '{title}',
          autoTags: [folder.split('/').pop()!.toLowerCase()],
        },
      };
      
      await manager.createContext(folderPath, context);
      console.log(`✅ Created custom context in ${folder}/`);
    }
  } catch (error) {
    console.error('❌ Error creating context:', getErrorMessage(error));
    process.exit(1);
  }
}

/**
 * Handle listing all contexts
 */
async function handleListContexts(options: any): Promise<void> {
  const manager = new ContextManager(vaultPath);
  
  try {
    const contexts = await manager.listContexts();
    
    if (options.json) {
      console.log(JSON.stringify(contexts, null, 2));
      return;
    }
    
    if (contexts.length === 0) {
      console.log('No contexts found in vault.');
      console.log('\nUse "dome context create <folder>" to create one.');
      console.log('Or use "dome setup" for guided setup.');
      return;
    }
    
    console.log('Contexts in vault:\n');
    for (const { path, context } of contexts) {
      if (context) {
        console.log(`📁 ${path || '/ (root)'}`);
        console.log(`   Name: ${context.name}`);
        console.log(`   Description: ${context.description}`);
        
        if (context.rules?.fileNaming) {
          console.log(`   File naming: ${context.rules.fileNaming}`);
        }
        
        if (context.rules?.autoTags?.length) {
          console.log(`   Auto tags: ${context.rules.autoTags.join(', ')}`);
        }
        
        if (context.rules?.requiredFields?.length) {
          console.log(`   Required fields: ${context.rules.requiredFields.join(', ')}`);
        }
        
        console.log();
      }
    }
  } catch (error) {
    console.error('❌ Error listing contexts:', getErrorMessage(error));
    process.exit(1);
  }
}

/**
 * Handle note validation
 */
async function handleValidateNote(notePath: string): Promise<void> {
  const manager = new ContextManager(vaultPath);
  const fullPath = join(vaultPath, notePath);
  
  try {
    // Read the note
    const content = await fs.readFile(fullPath, 'utf-8');
    
    // Find context
    const contextResult = await manager.findContextForPath(fullPath);
    if (!contextResult) {
      console.log('ℹ️  No context found for this note.');
      return;
    }
    
    console.log(`Context: ${contextResult.context.name}`);
    if (contextResult.isInherited) {
      console.log(`(Inherited from ${contextResult.depth} level${contextResult.depth > 1 ? 's' : ''} up)`);
    }
    console.log();
    
    // Validate
    const validation = await manager.validateNoteAgainstContext(fullPath, content);
    
    if (validation.isValid && validation.warnings.length === 0) {
      console.log('✅ Note is valid according to context rules');
    } else {
      if (validation.errors.length > 0) {
        console.log('❌ Validation errors:');
        for (const error of validation.errors) {
          console.log(`   • ${error.message}`);
        }
      }
      
      if (validation.warnings.length > 0) {
        console.log('\n⚠️  Warnings:');
        for (const warning of validation.warnings) {
          console.log(`   • ${warning.message}`);
        }
      }
    }
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      console.error(`❌ Note not found: ${notePath}`);
    } else {
      console.error('❌ Error validating note:', getErrorMessage(error));
    }
    process.exit(1);
  }
}