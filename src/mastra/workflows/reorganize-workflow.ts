import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { prompts } from '../prompts/PromptRegistry.js';

// Types
interface ReorganizeOptions {
  dryRun: boolean;
  verbose: boolean;
  mergeDuplicates: boolean;
  cleanupEmpty: boolean;
}

interface MergeGroup {
  notePaths: string[];
  proposedTitle: string;
  proposedLocation: string;
  reason: string;
  confidence: number;
}

// Input/Output schemas
const MergeGroupSchema = z.object({
  notePaths: z.array(z.string()),
  proposedTitle: z.string(),
  proposedLocation: z.string(),
  reason: z.string(),
  confidence: z.number().min(0).max(1),
});

const RemovalCandidateSchema = z.object({
  path: z.string(),
  reason: z.string(),
  confidence: z.number().min(0).max(1),
});

// Structured output schemas for AI responses
const MergeNotesResponseSchema = z.object({
  mergeGroups: z.array(MergeGroupSchema),
  reasoning: z.string(),
});

const RemoveNotesResponseSchema = z.object({
  removalCandidates: z.array(RemovalCandidateSchema),
  reasoning: z.string(),
});

// Constants
export const DEFAULT_OPTIONS: Readonly<ReorganizeOptions> = {
  dryRun: false,
  verbose: false,
  mergeDuplicates: true,
  cleanupEmpty: true,
} as const;

// Shared options schema
const OptionsSchema = z
  .object({
    dryRun: z.boolean(),
    verbose: z.boolean(),
    mergeDuplicates: z.boolean(),
    cleanupEmpty: z.boolean(),
  })
  .strict();

const ReorganizeInputSchema = z.object({
  options: z.object({
    dryRun: z.boolean().default(false),
    verbose: z.boolean().default(false),
    mergeDuplicates: z.boolean().default(true),
    cleanupEmpty: z.boolean().default(true),
  }),
});

const ReorganizeOutputSchema = z.object({
  mergeGroupsFound: z.number(),
  notesRemoved: z.number(),
  notesMerged: z.number(),
  actions: z.array(z.string()),
  errors: z.array(z.string()),
});

// Step 1: Identify merge groups
const identifyMergeGroupsStep = createStep({
  id: 'identify-merge-groups',
  description: 'Use AI agent to identify groups of notes that should be merged',
  inputSchema: ReorganizeInputSchema,
  outputSchema: z.object({
    mergeGroups: z.array(MergeGroupSchema),
    options: OptionsSchema,
  }),
  execute: async (context: any) => {
    const { inputData: input, mastra } = context;
    const options = { ...DEFAULT_OPTIONS, ...input?.options };

    console.log('🔍 AI agent identifying merge groups...');

    if (!options.mergeDuplicates) {
      return {
        mergeGroups: [],
        options,
      };
    }

    const agent = mastra.getAgent('notesAgent');
    if (!agent) {
      throw new Error('notesAgent not registered in mastra - check agent configuration');
    }

    const identifyPrompt = prompts.identifyMergeGroups();

    try {
      const response = await agent.generate([{ role: 'user', content: identifyPrompt }], {
        experimental_output: MergeNotesResponseSchema,
      });

      const mergeGroups = response.object?.mergeGroups || [];

      if (options.verbose) {
        console.log(`Merge analysis complete: ${mergeGroups.length} merge groups identified`);
        console.log(`Agent reasoning: ${response.object?.reasoning}`);
      }

      // Enhanced dry-run logging for merge groups
      if (options.dryRun && mergeGroups.length > 0) {
        console.log('\n📋 Merge Groups Identified:');
        console.log('==========================');
        mergeGroups.forEach((group: MergeGroup, index: number) => {
          console.log(`\n${index + 1}. ${group.proposedTitle}`);
          console.log(`   📁 Target location: ${group.proposedLocation}`);
          console.log(`   🎯 Confidence: ${(group.confidence * 100).toFixed(1)}%`);
          console.log(`   💭 Reason: ${group.reason}`);
          console.log(`   📝 Notes to merge (${group.notePaths.length}):`);
          group.notePaths.forEach((path: string) => {
            console.log(`      - ${path}`);
          });
        });
      }

      return {
        mergeGroups,
        options,
      };
    } catch (error) {
      console.error(
        'Failed to identify merge candidates:',
        error instanceof Error ? error.message : 'Unknown error'
      );
      return {
        mergeGroups: [],
        options,
      };
    }
  },
});

// Step 2: Execute merges
const executeMergesStep = createStep({
  id: 'execute-merges',
  description: 'Execute all high-confidence merges in a single operation',
  inputSchema: z.object({
    mergeGroups: z.array(MergeGroupSchema),
    options: OptionsSchema,
  }),
  outputSchema: z.object({
    notesMerged: z.number(),
    actions: z.array(z.string()),
    errors: z.array(z.string()),
    options: OptionsSchema,
  }),
  execute: async (context: any) => {
    const { inputData: input, mastra } = context;
    const options = { ...DEFAULT_OPTIONS, ...input?.options };
    const mergeGroups = input?.mergeGroups || [];

    console.log('🔗 AI agent executing merges...');

    // Filter high-confidence merge groups
    const highConfidenceGroups = mergeGroups.filter((group: MergeGroup) => group.confidence >= 0.7);

    if (highConfidenceGroups.length === 0) {
      return {
        notesMerged: 0,
        actions: [],
        errors: [],
        options,
      };
    }

    const agent = mastra.getAgent('notesAgent');
    if (!agent) {
      throw new Error('notesAgent not registered in mastra - check agent configuration');
    }

    const actions: string[] = [];
    const errors: string[] = [];

    if (options.verbose) {
      console.log(`Executing ${highConfidenceGroups.length} high-confidence merges...`);
    }

    if (!options.dryRun) {
      const executePrompt = prompts.executeMerges(highConfidenceGroups);

      try {
        await agent.generate([{ role: 'user', content: executePrompt }]);

        // Count merged notes and create action entries
        let totalMerged = 0;
        for (const group of highConfidenceGroups) {
          totalMerged += group.notePaths.length;
          const action = `Merged ${group.notePaths.length} notes into ${group.proposedLocation}`;
          actions.push(action);

          if (options.verbose) {
            console.log(`  ${action}`);
          }
        }

        return {
          notesMerged: totalMerged,
          actions,
          errors,
          options,
        };
      } catch (error) {
        errors.push(
          `Failed to execute merges: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
        return {
          notesMerged: 0,
          actions,
          errors,
          options,
        };
      }
    } else {
      // Dry run - just count what would be merged
      let totalMerged = 0;

      if (highConfidenceGroups.length > 0) {
        console.log('\n🔗 High-Confidence Merges (≥70%) to Execute:');
        console.log('=============================================');
      }

      for (const group of highConfidenceGroups) {
        totalMerged += group.notePaths.length;
        const action = `Would merge ${group.notePaths.length} notes into ${group.proposedLocation}`;
        actions.push(action);

        // Detailed dry-run output for each merge
        console.log(`\n📝 ${group.proposedTitle}`);
        console.log(`   📁 Target: ${group.proposedLocation}`);
        console.log(`   🎯 Confidence: ${(group.confidence * 100).toFixed(1)}%`);
        console.log(`   💭 Reason: ${group.reason}`);
        console.log(`   📋 Source notes (${group.notePaths.length}):`);
        group.notePaths.forEach((path: string) => {
          console.log(`      → ${path}`);
        });

        if (options.verbose) {
          console.log(`  ${action}`);
        }
      }

      // Show lower confidence groups that won't be executed
      const lowConfidenceGroups = mergeGroups.filter((group: MergeGroup) => group.confidence < 0.7);
      if (lowConfidenceGroups.length > 0) {
        console.log('\n⚠️  Lower-Confidence Merges (<70%) - Not Executed:');
        console.log('==================================================');
        lowConfidenceGroups.forEach((group: MergeGroup) => {
          console.log(`\n📝 ${group.proposedTitle}`);
          console.log(`   🎯 Confidence: ${(group.confidence * 100).toFixed(1)}% (too low)`);
          console.log(`   💭 Reason: ${group.reason}`);
          console.log(`   📋 Notes: ${group.notePaths.join(', ')}`);
        });
      }

      return {
        notesMerged: totalMerged,
        actions,
        errors,
        options,
      };
    }
  },
});

// Step 3: Agent-driven note removal
const removeNotesStep = createStep({
  id: 'remove-notes',
  description: 'Use AI agent to autonomously identify and remove low-value notes',
  inputSchema: z.object({
    notesMerged: z.number(),
    actions: z.array(z.string()),
    errors: z.array(z.string()),
    options: OptionsSchema,
  }),
  outputSchema: z.object({
    notesMerged: z.number(),
    notesRemoved: z.number(),
    actions: z.array(z.string()),
    errors: z.array(z.string()),
    options: OptionsSchema,
  }),
  execute: async (context: any) => {
    const { inputData: input, mastra } = context;
    const options = { ...DEFAULT_OPTIONS, ...input?.options };

    console.log('🗑️ AI agent cleaning up low-value notes...');

    const actions = [...(input?.actions || [])];
    const errors = [...(input?.errors || [])];

    if (!options.cleanupEmpty) {
      return {
        notesMerged: input?.notesMerged || 0,
        notesRemoved: 0,
        actions,
        errors,
        options,
      };
    }

    const agent = mastra.getAgent('notesAgent');
    if (!agent) {
      throw new Error('notesAgent not registered in mastra - check agent configuration');
    }

    if (!options.dryRun) {
      const cleanupPrompt = prompts.cleanupNotes();

      try {
        const response = await agent.generate([{ role: 'user', content: cleanupPrompt }]);

        // Parse response to count removed notes
        const responseText = response.text || '';
        const countMatch = responseText.match(/(\d+)\s+notes?\s+(?:removed|deleted)/i);
        const notesRemoved = countMatch ? parseInt(countMatch[1]) : 0;

        actions.push(`Agent removed ${notesRemoved} low-value notes`);

        if (options.verbose) {
          console.log(`  Agent removed ${notesRemoved} low-value notes`);
        }

        return {
          notesMerged: input?.notesMerged || 0,
          notesRemoved,
          actions,
          errors,
          options,
        };
      } catch (error) {
        errors.push(
          `Failed to clean up notes: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
        return {
          notesMerged: input?.notesMerged || 0,
          notesRemoved: 0,
          actions,
          errors,
          options,
        };
      }
    } else {
      // Dry run - identify but don't remove
      const analyzePrompt = prompts.analyzeNotesForCleanup();

      try {
        const response = await agent.generate([{ role: 'user', content: analyzePrompt }], {
          experimental_output: RemoveNotesResponseSchema,
        });

        const removalCandidates = response.object?.removalCandidates || [];
        const highConfidenceRemovals = removalCandidates.filter(
          (candidate: any) => candidate.confidence >= 0.7
        );
        const lowConfidenceRemovals = removalCandidates.filter(
          (candidate: any) => candidate.confidence < 0.7
        );

        // Enhanced dry-run logging for removals
        if (highConfidenceRemovals.length > 0) {
          console.log('\n🗑️  Notes to Remove (≥70% confidence):');
          console.log('======================================');
          highConfidenceRemovals.forEach((candidate: any, index: number) => {
            console.log(`\n${index + 1}. ${candidate.path}`);
            console.log(`   🎯 Confidence: ${(candidate.confidence * 100).toFixed(1)}%`);
            console.log(`   💭 Reason: ${candidate.reason}`);
          });
        }

        if (lowConfidenceRemovals.length > 0) {
          console.log('\n⚠️  Lower-Confidence Removal Candidates (<70%) - Not Removed:');
          console.log('=============================================================');
          lowConfidenceRemovals.forEach((candidate: any, index: number) => {
            console.log(`\n${index + 1}. ${candidate.path}`);
            console.log(`   🎯 Confidence: ${(candidate.confidence * 100).toFixed(1)}% (too low)`);
            console.log(`   💭 Reason: ${candidate.reason}`);
          });
        }

        if (options.verbose && response.object?.reasoning) {
          console.log(`\n🤖 AI Analysis: ${response.object.reasoning}`);
        }

        const notesRemoved = highConfidenceRemovals.length;
        actions.push(`Would remove ${notesRemoved} low-value notes`);

        if (options.verbose) {
          console.log(`  Would remove ${notesRemoved} low-value notes`);
        }

        return {
          notesMerged: input?.notesMerged || 0,
          notesRemoved,
          actions,
          errors,
          options,
        };
      } catch (error) {
        errors.push(
          `Failed to analyze notes for cleanup: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
        return {
          notesMerged: input?.notesMerged || 0,
          notesRemoved: 0,
          actions,
          errors,
          options,
        };
      }
    }
  },
});

// Create the reorganize workflow
export const reorganizeWorkflow = createWorkflow({
  id: 'reorganize-workflow',
  description: 'AI-powered agent-driven notes reorganization workflow',
  inputSchema: ReorganizeInputSchema,
  outputSchema: ReorganizeOutputSchema,
})
  .then(identifyMergeGroupsStep)
  .then(executeMergesStep)
  .then(removeNotesStep)
  .commit();
