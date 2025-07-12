import { Command } from 'commander';
import { mastra } from '../../mastra/index.js';

export function createReorganizeCommand(): Command {
  const command = new Command('reorganize');

  command
    .description('AI-powered reorganization of notes using Mastra workflows')
    .option('--dry-run', 'Show what would be done without making changes', false)
    .option('--verbose', 'Show detailed progress information', false)
    .option('--no-merge', 'Skip merging duplicate notes', false)
    .option('--no-cleanup', 'Skip cleaning up empty files', false)
    .action(async (options) => {
      await handleReorganize(options);
    });

  return command;
}

export async function handleReorganize(options: any): Promise<void> {
  console.log('🤖 Starting AI-powered notes reorganization...');

  const reorganizeOptions = {
    dryRun: options.dryRun || false,
    verbose: options.verbose || false,
    mergeDuplicates: !options.noMerge,
    cleanupEmpty: !options.noCleanup
  };

  if (reorganizeOptions.dryRun) {
    console.log('🔍 DRY RUN MODE - No changes will be made\n');
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
        options: reorganizeOptions
      }
    });

    if (result.status === 'success' && result.result) {
      // Display results
      console.log('\n📊 AI-Powered Reorganization Results:');
      console.log('====================================');

      console.log(`🔗 Merge groups identified: ${result.result.mergeGroupsFound}`);
      console.log(`🗑️ Notes removed: ${result.result.notesRemoved}`);
      console.log(`📝 Notes merged: ${result.result.notesMerged}`);

      const totalActions = result.result.notesRemoved + result.result.notesMerged;
      if (totalActions === 0) {
        console.log('✨ No actions needed - your notes are already well organized!');
      }

      if (result.result.errors.length > 0) {
        console.log(`⚠️  Errors encountered: ${result.result.errors.length}`);
        if (reorganizeOptions.verbose) {
          result.result.errors.forEach((error: string) => console.log(`  - ${error}`));
        }
      }

      if (reorganizeOptions.verbose && result.result.actions.length > 0) {
        console.log('\n📋 AI-Recommended Actions:');
        result.result.actions.forEach((action: string) => console.log(`  - ${action}`));
      }

      if (reorganizeOptions.dryRun && result.result.actions.length > 0) {
        console.log('\n💡 To apply these AI-recommended changes, run the command without --dry-run');
      }

    } else if (result.status === 'failed') {
      console.error(`❌ Workflow failed: ${result.error}`);
      if (reorganizeOptions.verbose && result.steps) {
        console.log('\nWorkflow step details:');
        Object.entries(result.steps).forEach(([stepId, stepResult]: [string, any]) => {
          console.log(`  ${stepId}: ${stepResult.status}`);
          if (stepResult.error) {
            console.log(`    Error: ${stepResult.error}`);
          }
        });
      }
    } else if (result.status === 'suspended') {
      console.log('⏸️ Workflow suspended. This is unexpected for the reorganize workflow.');
    }

  } catch (error) {
    console.error('❌ Failed to run reorganization workflow:', error instanceof Error ? error.message : 'Unknown error');

    if (error instanceof Error && error.message.includes('Notes agent not available')) {
      console.log('\n💡 Tip: Make sure you have configured the OpenAI API key for AI-powered reorganization.');
      console.log('Set the OPENAI_API_KEY environment variable or check your Mastra configuration.');
    }
  }

  console.log('\n✅ AI-powered reorganization complete!');
}
