import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";

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
  confidence: z.number().min(0).max(1)
}).strict();

const RemovalCandidateSchema = z.object({
  path: z.string(),
  reason: z.string(),
  confidence: z.number().min(0).max(1)
}).strict();

// Structured output schemas for AI responses
const MergeNotesResponseSchema = z.object({
  mergeGroups: z.array(MergeGroupSchema),
  reasoning: z.string()
}).strict();

const RemoveNotesResponseSchema = z.object({
  removalCandidates: z.array(RemovalCandidateSchema),
  reasoning: z.string()
}).strict();

// Constants
export const DEFAULT_OPTIONS: Readonly<ReorganizeOptions> = {
  dryRun: false,
  verbose: false,
  mergeDuplicates: true,
  cleanupEmpty: true
} as const;

// Shared options schema
const OptionsSchema = z.object({
  dryRun: z.boolean(),
  verbose: z.boolean(),
  mergeDuplicates: z.boolean(),
  cleanupEmpty: z.boolean()
}).strict();

const ReorganizeInputSchema = z.object({
  options: z.object({
    dryRun: z.boolean().default(false),
    verbose: z.boolean().default(false),
    mergeDuplicates: z.boolean().default(true),
    cleanupEmpty: z.boolean().default(true)
  })
});

const ReorganizeOutputSchema = z.object({
  mergeGroupsFound: z.number(),
  notesRemoved: z.number(),
  notesMerged: z.number(),
  actions: z.array(z.string()),
  errors: z.array(z.string())
});

// Step 1: Identify merge groups
const identifyMergeGroupsStep = createStep({
  id: "identify-merge-groups",
  description: "Use AI agent to identify groups of notes that should be merged",
  inputSchema: ReorganizeInputSchema,
  outputSchema: z.object({
    mergeGroups: z.array(MergeGroupSchema),
    options: OptionsSchema
  }),
  execute: async (context: any) => {
    const { inputData: input, mastra } = context;
    const options = { ...DEFAULT_OPTIONS, ...input?.options };

    console.log("🔍 AI agent identifying merge groups...");

    if (!options.mergeDuplicates) {
      return {
        mergeGroups: [],
        options
      };
    }

    const agent = mastra.getAgent('notesAgent');
    if (!agent) {
      throw new Error('notesAgent not registered in mastra - check agent configuration');
    }

    const identifyPrompt = `You are helping reorganize a notes vault. Your task is to identify groups of notes that should be merged into single, well-organized notes.

Please use your tools to:
1. List all notes in the vault to get an overview
2. Examine promising candidates for merging by reading their content
3. Identify groups of 2-5 notes that cover similar topics and should be merged

Look for notes that:
- Cover the same topic but are scattered across multiple files
- Are incomplete drafts that should be combined into a comprehensive note
- Have overlapping content that would benefit from consolidation
- Are follow-ups or continuations of previous notes

For each merge group, propose:
- Which notes should be merged (list their paths)
- A good title for the merged note
- A logical location/path for the merged note
- Clear reasoning for why these notes should be merged
- Confidence level (0.0-1.0) in your recommendation

Focus on merges that will genuinely improve the organization and reduce redundancy. Be conservative - only suggest merges you're confident about.`;

    try {
      const response = await agent.generate([{ role: 'user', content: identifyPrompt }], {
        output: MergeNotesResponseSchema
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
        options
      };
    } catch (error) {
      console.error('Failed to identify merge candidates:', error instanceof Error ? error.message : 'Unknown error');
      return {
        mergeGroups: [],
        options
      };
    }
  }
});

// Step 2: Execute merges
const executeMergesStep = createStep({
  id: "execute-merges",
  description: "Execute all high-confidence merges in a single operation",
  inputSchema: z.object({
    mergeGroups: z.array(MergeGroupSchema),
    options: OptionsSchema
  }),
  outputSchema: z.object({
    notesMerged: z.number(),
    actions: z.array(z.string()),
    errors: z.array(z.string()),
    options: OptionsSchema
  }),
  execute: async (context: any) => {
    const { inputData: input, mastra } = context;
    const options = { ...DEFAULT_OPTIONS, ...input?.options };
    const mergeGroups = input?.mergeGroups || [];

    console.log("🔗 AI agent executing merges...");

    // Filter high-confidence merge groups
    const highConfidenceGroups = mergeGroups.filter((group: MergeGroup) => group.confidence >= 0.7);

    if (highConfidenceGroups.length === 0) {
      return {
        notesMerged: 0,
        actions: [],
        errors: [],
        options
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
      const executePrompt = `You need to execute ${highConfidenceGroups.length} note merges. For each merge group below, use your tools to:

1. Read all the source notes
2. Create a well-organized merged note that combines all unique content
3. Write the merged note to the proposed location
4. Remove the original source notes using your removeNoteTool

Here are the merge groups to execute:

${highConfidenceGroups.map((group: MergeGroup, index: number) => `
Merge Group ${index + 1}:
- Notes to merge: ${JSON.stringify(group.notePaths)}
- Merged note location: ${group.proposedLocation}
- Merged note title: ${group.proposedTitle}
- Reason: ${group.reason}
- Confidence: ${group.confidence}
`).join('\n')}

Please execute all these merges systematically. Report back on your progress.`;

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
          options
        };
      } catch (error) {
        errors.push(`Failed to execute merges: ${error instanceof Error ? error.message : 'Unknown error'}`);
        return {
          notesMerged: 0,
          actions,
          errors,
          options
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
        options
      };
    }
  }
});

// Step 3: Agent-driven note removal
const removeNotesStep = createStep({
  id: "remove-notes",
  description: "Use AI agent to autonomously identify and remove low-value notes",
  inputSchema: z.object({
    notesMerged: z.number(),
    actions: z.array(z.string()),
    errors: z.array(z.string()),
    options: OptionsSchema
  }),
  outputSchema: z.object({
    notesMerged: z.number(),
    notesRemoved: z.number(),
    actions: z.array(z.string()),
    errors: z.array(z.string()),
    options: OptionsSchema
  }),
  execute: async (context: any) => {
    const { inputData: input, mastra } = context;
    const options = { ...DEFAULT_OPTIONS, ...input?.options };

    console.log("🗑️ AI agent cleaning up low-value notes...");

    const actions = [...(input?.actions || [])];
    const errors = [...(input?.errors || [])];

    if (!options.cleanupEmpty) {
      return {
        notesMerged: input?.notesMerged || 0,
        notesRemoved: 0,
        actions,
        errors,
        options
      };
    }

    const agent = mastra.getAgent('notesAgent');
    if (!agent) {
      throw new Error('notesAgent not registered in mastra - check agent configuration');
    }

    if (!options.dryRun) {
      const cleanupPrompt = `You are cleaning up a notes vault by removing low-value notes. Please use your tools to:

1. List all notes in the vault to get an overview
2. Examine notes that might be candidates for removal
3. For notes that are clearly low-value, use your removeNoteTool to delete them

Look for notes that should be removed:
- Empty or nearly empty (just a title, minimal content)
- Only placeholder text, TODOs with no actual content
- Test notes or temporary files that serve no purpose
- Extremely low quality, garbled, or broken content
- Duplicate information that's better covered elsewhere

Be conservative - only remove notes you're highly confident are worthless (confidence >= 0.7). When in doubt, keep the note.

For each note you remove, briefly explain why it was removed. Count how many notes you remove and report back.`;

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
          options
        };
      } catch (error) {
        errors.push(`Failed to clean up notes: ${error instanceof Error ? error.message : 'Unknown error'}`);
        return {
          notesMerged: input?.notesMerged || 0,
          notesRemoved: 0,
          actions,
          errors,
          options
        };
      }
    } else {
      // Dry run - identify but don't remove
      const analyzePrompt = `You are analyzing a notes vault for cleanup. Please use your tools to:

1. List all notes in the vault
2. Identify notes that would be candidates for removal
3. For each removal candidate, provide the reason and confidence level

Look for notes that should be removed:
- Empty or nearly empty (just a title, minimal content)
- Only placeholder text, TODOs with no actual content
- Test notes or temporary files that serve no purpose
- Extremely low quality, garbled, or broken content
- Duplicate information that's better covered elsewhere

Be conservative - only identify notes you're highly confident are worthless (confidence >= 0.7).

Provide your analysis in this structured format:
{
  "removalCandidates": [
    {
      "path": "path/to/note.md",
      "reason": "Specific reason for removal",
      "confidence": 0.85
    }
  ],
  "reasoning": "Overall analysis of the cleanup process"
}`;

      try {
        const response = await agent.generate([{ role: 'user', content: analyzePrompt }], {
          output: RemoveNotesResponseSchema
        });

        const removalCandidates = response.object?.removalCandidates || [];
        const highConfidenceRemovals = removalCandidates.filter(candidate => candidate.confidence >= 0.7);
        const lowConfidenceRemovals = removalCandidates.filter(candidate => candidate.confidence < 0.7);

        // Enhanced dry-run logging for removals
        if (highConfidenceRemovals.length > 0) {
          console.log('\n🗑️  Notes to Remove (≥70% confidence):');
          console.log('======================================');
          highConfidenceRemovals.forEach((candidate, index) => {
            console.log(`\n${index + 1}. ${candidate.path}`);
            console.log(`   🎯 Confidence: ${(candidate.confidence * 100).toFixed(1)}%`);
            console.log(`   💭 Reason: ${candidate.reason}`);
          });
        }

        if (lowConfidenceRemovals.length > 0) {
          console.log('\n⚠️  Lower-Confidence Removal Candidates (<70%) - Not Removed:');
          console.log('=============================================================');
          lowConfidenceRemovals.forEach((candidate, index) => {
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
          options
        };
      } catch (error) {
        errors.push(`Failed to analyze notes for cleanup: ${error instanceof Error ? error.message : 'Unknown error'}`);
        return {
          notesMerged: input?.notesMerged || 0,
          notesRemoved: 0,
          actions,
          errors,
          options
        };
      }
    }
  }
});

// Create the reorganize workflow
export const reorganizeWorkflow = createWorkflow({
  id: "reorganize-workflow",
  description: "AI-powered agent-driven notes reorganization workflow",
  inputSchema: ReorganizeInputSchema,
  outputSchema: ReorganizeOutputSchema
})
  .then(identifyMergeGroupsStep)
  .then(executeMergesStep)
  .then(removeNotesStep)
  .commit();

