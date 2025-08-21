import { Command } from 'commander';
import { mastra } from '../../mastra/index.js';
import { run } from '../utils/command-runner.js';
import logger from '../../core/utils/logger.js';

export function createReorganizeCommand(): Command {
  const command = new Command('reorganize');

  command
    .description('AI-powered reorganization of notes using Mastra workflows')
    .option('--dry-run', 'Show what would be done without making changes', false)
    .option('--verbose', 'Show detailed progress information', false)
    .option('--no-merge', 'Skip merging duplicate notes', false)
    .option('--no-cleanup', 'Skip cleaning up empty files', false)
    .action((options) => run(() => handleReorganize(options)));

  return command;
}

export async function handleReorganize(options: any): Promise<void> {
  logger.info('🤖 Starting AI-powered notes reorganization...');

  const reorganizeOptions = {
    dryRun: options.dryRun || false,
    verbose: options.verbose || false,
    mergeDuplicates: !options.noMerge,
    cleanupEmpty: !options.noCleanup,
  };

  if (reorganizeOptions.dryRun) {
    logger.info('🔍 DRY RUN MODE - No changes will be made\n');
  }

  try {
    // Get the reorganize workflow
    const workflow = mastra.getWorkflow('reorganizeWorkflow');
    if (!workflow) {
      throw new Error('Reorganize workflow not found. Please check your Mastra configuration.');
    }

    // Create and start workflow run
    const run = await workflow.createRunAsync();

    const result = await run.start({
      inputData: {
        options: reorganizeOptions,
      },
    });

    if (result.status === 'success' && result.result) {
      // Display results
      logger.info('\n📊 AI-Powered Reorganization Results:');
      logger.info('====================================');

      logger.info(`🔗 Merge groups identified: ${result.result.mergeGroupsFound}`);
      logger.info(`🗑️ Notes removed: ${result.result.notesRemoved}`);
      logger.info(`📝 Notes merged: ${result.result.notesMerged}`);

      const totalActions = result.result.notesRemoved + result.result.notesMerged;
      if (totalActions === 0) {
        logger.info('✨ No actions needed - your notes are already well organized!');
      }

      if (result.result.errors.length > 0) {
        logger.warn(`⚠️  Errors encountered: ${result.result.errors.length}`);
        if (reorganizeOptions.verbose) {
          result.result.errors.forEach((error: string) => logger.debug(`  - ${error}`));
        }
      }

      if (reorganizeOptions.verbose && result.result.actions.length > 0) {
        logger.info('\n📋 AI-Recommended Actions:');
        result.result.actions.forEach((action: string) => logger.debug(`  - ${action}`));
      }

      if (reorganizeOptions.dryRun && result.result.actions.length > 0) {
        logger.info(
          '\n💡 To apply these AI-recommended changes, run the command without --dry-run'
        );
      }
    } else if (result.status === 'failed') {
      logger.error(`❌ Workflow failed: ${result.error}`);
      if (reorganizeOptions.verbose && result.steps) {
        logger.info('\nWorkflow step details:');
        Object.entries(result.steps).forEach(([stepId, stepResult]: [string, any]) => {
          logger.debug(`  ${stepId}: ${stepResult.status}`);
          if (stepResult.error) {
            logger.debug(`    Error: ${stepResult.error}`);
          }
        });
      }
    } else if (result.status === 'suspended') {
      logger.warn('⏸️ Workflow suspended. This is unexpected for the reorganize workflow.');
    }
  } catch (error) {
    logger.error(
      '❌ Failed to run reorganization workflow:',
      error instanceof Error ? error.message : 'Unknown error'
    );

    if (error instanceof Error && error.message.includes('Notes agent not available')) {
      logger.info(
        '\n💡 Tip: Make sure you have configured the OpenAI API key for AI-powered reorganization.'
      );
      logger.info(
        'Set the OPENAI_API_KEY environment variable or check your Mastra configuration.'
      );
    }
  }

  logger.info('\n✅ AI-powered reorganization complete!');
}
