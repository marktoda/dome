import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { listNotes, getNote, type Note } from "../core/notes.js";
import fs from "node:fs/promises";
import matter from "gray-matter";
import path from "node:path";

const vaultPath = process.env.DOME_VAULT_PATH ?? `${process.env.HOME}/dome`;

// Types
interface ReorganizeOptions {
  dryRun: boolean;
  verbose: boolean;
  mergeDuplicates: boolean;
  addSummaries: boolean;
  cleanupEmpty: boolean;
}

interface QualityAssessment {
  path: string;
  shouldRemove: boolean;
  quality: "high" | "medium" | "low";
  reason: string;
  suggestions?: string;
}

interface DuplicateGroup {
  primaryNote: Note;
  duplicates: Note[];
  mergeStrategy: string;
  confidence: number;
}

interface StepExecutionContext {
  input: any;
  mastra: any;
}

// Structured output schemas for AI responses
const QualityAssessmentResponseSchema = z.object({
  assessments: z.array(z.object({
    path: z.string(),
    shouldRemove: z.boolean(),
    quality: z.enum(["high", "medium", "low"]),
    reason: z.string(),
    suggestions: z.string().optional()
  }))
});

const DuplicateDetectionResponseSchema = z.object({
  duplicates: z.array(z.object({
    candidatePath: z.string(),
    isDuplicate: z.boolean(),
    confidence: z.number().min(0).max(1),
    reason: z.string(),
    mergeStrategy: z.string()
  }))
});

// Input/Output schemas
const NoteSchema = z.object({
  title: z.string(),
  date: z.string(),
  tags: z.array(z.string()),
  path: z.string(),
  body: z.string(),
  fullPath: z.string(),
  source: z.enum(["cli", "external"])
});

const QualityAssessmentSchema = z.object({
  path: z.string(),
  shouldRemove: z.boolean(),
  quality: z.enum(["high", "medium", "low"]),
  reason: z.string(),
  suggestions: z.string().optional()
});

const DuplicateGroupSchema = z.object({
  primaryNote: NoteSchema,
  duplicates: z.array(NoteSchema),
  mergeStrategy: z.string(),
  confidence: z.number()
});

// Shared options schema
const OptionsSchema = z.object({
  dryRun: z.boolean(),
  verbose: z.boolean(),
  mergeDuplicates: z.boolean(),
  addSummaries: z.boolean(),
  cleanupEmpty: z.boolean()
});

const ReorganizeInputSchema = z.object({
  options: z.object({
    dryRun: z.boolean().default(false),
    verbose: z.boolean().default(false),
    mergeDuplicates: z.boolean().default(true),
    addSummaries: z.boolean().default(true),
    cleanupEmpty: z.boolean().default(true)
  })
});

const ReorganizeOutputSchema = z.object({
  notesAnalyzed: z.number(),
  lowQualityRemoved: z.number(),
  duplicatesFound: z.number(),
  duplicatesMerged: z.number(),
  summariesAdded: z.number(),
  actions: z.array(z.string()),
  errors: z.array(z.string())
});

// Step 1: Load and analyze all notes
const loadNotesStep = createStep({
  id: "load-notes",
  description: "Load all notes from the vault for analysis",
  inputSchema: ReorganizeInputSchema,
  outputSchema: z.object({
    notes: z.array(NoteSchema),
    options: OptionsSchema
  }),
  execute: async (context: any) => {
    const { inputData: input, mastra } = context;
    console.log("📚 Loading notes from vault...");

    const defaultOptions: ReorganizeOptions = {
      dryRun: false,
      verbose: false,
      mergeDuplicates: true,
      addSummaries: true,
      cleanupEmpty: true
    };

    try {
      const noteMetas = await listNotes();
      const notes: Note[] = [];

      for (const meta of noteMetas) {
        try {
          const note = await getNote(meta.path);
          if (note) {
            notes.push(note);
          }
        } catch (error) {
          console.error(`Failed to load note ${meta.path}:`, error instanceof Error ? error.message : 'Unknown error');
        }
      }

      console.log(`Found ${notes.length} notes to analyze`);

      return {
        notes,
        options: input?.options || defaultOptions
      };
    } catch (error) {
      throw new Error(`Failed to load notes: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
});

// Step 2: AI-powered quality assessment
const qualityAssessmentStep = createStep({
  id: "quality-assessment",
  description: "Use AI to assess note quality and identify low-value notes",
  inputSchema: z.object({
    notes: z.array(NoteSchema),
    options: OptionsSchema
  }),
  outputSchema: z.object({
    qualityAssessments: z.array(QualityAssessmentSchema),
    remainingNotes: z.array(NoteSchema),
    options: OptionsSchema
  }),
  execute: async (context: any) => {
    const { inputData: input, mastra } = context;
    
    const defaultOptions: ReorganizeOptions = {
      dryRun: false,
      verbose: false,
      mergeDuplicates: true,
      addSummaries: true,
      cleanupEmpty: true
    };

    if (!input?.options?.cleanupEmpty) {
      return {
        qualityAssessments: [],
        remainingNotes: input?.notes || [],
        options: input?.options || defaultOptions
      };
    }

    console.log("🔍 AI-powered quality assessment...");

    const agent = mastra.getAgent('notesAgent');
    if (!agent) {
      throw new Error('Notes agent not available for quality assessment');
    }

    const qualityAssessments: QualityAssessment[] = [];
    const batchSize = 8;

    const notes: Note[] = input?.notes || [];
    for (let i = 0; i < notes.length; i += batchSize) {
      const batch = notes.slice(i, i + batchSize);

      const noteAnalysis = batch.map((note: Note) => ({
        path: note.path,
        title: note.title,
        content: note.body.substring(0, 400),
        wordCount: note.body.split(/\s+/).length,
        tags: note.tags
      }));

      const prompt = `Analyze these notes for quality and value. Identify notes that should be removed because they are:
- Empty or nearly empty (very little meaningful content)
- Only placeholder text, TODOs, or drafts with no real information
- Extremely low quality or garbled content
- Test notes or temporary files

For each note, assess if it should be kept or removed, and rate its quality.

Notes to analyze:
${JSON.stringify(noteAnalysis, null, 2)}`;

      try {
        const response = await agent.generate([{ role: 'user', content: prompt }], {
          output: QualityAssessmentResponseSchema
        });

        if (response.object?.assessments) {
          qualityAssessments.push(...response.object.assessments);
        }
      } catch (error) {
        console.error(`Failed to analyze batch starting at index ${i}:`, error instanceof Error ? error.message : 'Unknown error');
      }
    }

    // Filter remaining notes (those not marked for removal)
    const notesToRemove = new Set(
      qualityAssessments
        .filter((assessment: QualityAssessment) => assessment.shouldRemove)
        .map((assessment: QualityAssessment) => assessment.path)
    );

    const remainingNotes = notes.filter((note: Note) => !notesToRemove.has(note.path));

    if (input?.options?.verbose) {
      console.log(`Quality assessment complete: ${qualityAssessments.length} notes analyzed, ${notesToRemove.size} marked for removal`);
    }

    return {
      qualityAssessments,
      remainingNotes,
      options: input.options
    };
  }
});

// Step 3: AI-powered duplicate detection
const duplicateDetectionStep = createStep({
  id: "duplicate-detection",
  description: "Use AI to identify duplicate and similar notes",
  inputSchema: z.object({
    qualityAssessments: z.array(QualityAssessmentSchema),
    remainingNotes: z.array(NoteSchema),
    options: OptionsSchema
  }),
  outputSchema: z.object({
    qualityAssessments: z.array(QualityAssessmentSchema),
    duplicateGroups: z.array(DuplicateGroupSchema),
    uniqueNotes: z.array(NoteSchema),
    options: OptionsSchema
  }),
  execute: async (context: any) => {
    const { inputData: input, mastra } = context;
    const defaultOptions: ReorganizeOptions = {
      dryRun: false,
      verbose: false,
      mergeDuplicates: true,
      addSummaries: true,
      cleanupEmpty: true
    };

    if (!input?.options?.mergeDuplicates) {
      return {
        qualityAssessments: input?.qualityAssessments || [],
        duplicateGroups: [],
        uniqueNotes: input?.remainingNotes || [],
        options: input?.options || defaultOptions
      };
    }

    console.log("🔍 AI-powered duplicate detection...");

    const agent = mastra.getAgent('notesAgent');
    if (!agent) {
      throw new Error('Notes agent not available for duplicate detection');
    }

    const duplicateGroups: DuplicateGroup[] = [];
    const processed = new Set<string>();
    const notes: Note[] = input?.remainingNotes || [];

    // Compare notes in batches to find duplicates
    for (let i = 0; i < notes.length; i++) {
      if (processed.has(notes[i].path)) continue;

      const currentNote = notes[i];
      const candidates = notes.slice(i + 1).filter((note: any) => !processed.has(note.path));

      if (candidates.length === 0) {
        processed.add(currentNote.path);
        continue;
      }

      // Analyze this note against remaining candidates
      const comparisons = candidates.slice(0, 5); // Limit comparisons to avoid overwhelming AI

      const prompt = `Analyze if these notes are duplicates or contain substantially similar content that should be merged.

Primary Note:
Title: ${currentNote.title}
Path: ${currentNote.path}
Tags: ${currentNote.tags.join(', ')}
Content: ${currentNote.body.substring(0, 800)}

Candidate Notes:
${comparisons.map((note: any, idx: number) => `
${idx + 1}. Title: ${note.title}
   Path: ${note.path}
   Tags: ${note.tags.join(', ')}
   Content: ${note.body.substring(0, 600)}
`).join('')}

Consider them duplicates if they:
- Cover the same topic with similar information
- One is clearly a draft/incomplete version of another
- Have substantially overlapping content even with different titles
- One clearly supersedes or contains the other`;

      try {
        const response = await agent.generate([{ role: 'user', content: prompt }], {
          output: DuplicateDetectionResponseSchema
        });

        if (response.object?.duplicates) {
          const foundDuplicates = response.object.duplicates
            .filter((dup: any) => dup.isDuplicate && dup.confidence > 0.7)
            .map((dup: any) => candidates.find((c: Note) => c.path === dup.candidatePath))
            .filter((note: any): note is Note => note !== undefined);

          if (foundDuplicates.length > 0) {
            duplicateGroups.push({
              primaryNote: currentNote,
              duplicates: foundDuplicates,
              mergeStrategy: response.object.duplicates[0].mergeStrategy || "keep primary and merge content",
              confidence: Math.max(...response.object.duplicates.map((d: any) => d.confidence))
            });

            // Mark all as processed
            processed.add(currentNote.path);
            foundDuplicates.forEach((note: Note) => processed.add(note.path));

            if (input?.options?.verbose) {
              console.log(`Found duplicate group: ${currentNote.path} + ${foundDuplicates.length} duplicates`);
            }
          } else {
            processed.add(currentNote.path);
          }
        } else {
          processed.add(currentNote.path);
        }
      } catch (error) {
        console.error(`Failed to analyze duplicates for ${currentNote.path}:`, error);
        processed.add(currentNote.path);
      }
    }

    const uniqueNotes = notes.filter((note: any) => !processed.has(note.path));

    console.log(`Duplicate detection complete: ${duplicateGroups.length} groups found`);

    return {
      qualityAssessments: input.qualityAssessments,
      duplicateGroups,
      uniqueNotes,
      options: input.options
    };
  }
});

// Step 4: Execute cleanup and merging
const executeChangesStep = createStep({
  id: "execute-changes",
  description: "Execute the cleanup and merging operations",
  inputSchema: z.object({
    qualityAssessments: z.array(QualityAssessmentSchema),
    duplicateGroups: z.array(DuplicateGroupSchema),
    uniqueNotes: z.array(NoteSchema),
    options: OptionsSchema
  }),
  outputSchema: z.object({
    processedNotes: z.array(NoteSchema),
    actions: z.array(z.string()),
    errors: z.array(z.string()),
    options: OptionsSchema
  }),
  execute: async (context: any) => {
    const { inputData: input, mastra } = context;
    console.log("⚡ Executing cleanup and merge operations...");

    const actions: string[] = [];
    const errors: string[] = [];
    const processedNotes: Note[] = [...(input?.uniqueNotes || [])];

    // 1. Remove low-quality notes
    const notesToRemove: QualityAssessment[] = (input?.qualityAssessments || []).filter((assessment: QualityAssessment) => assessment.shouldRemove);

    for (const assessment of notesToRemove) {
      const action = `Remove low-quality note: ${assessment.path} (${assessment.reason})`;
      actions.push(action);

      if (input?.options?.verbose) {
        console.log(`  ${action}`);
      }

      if (!input?.options?.dryRun) {
        try {
          const fullPath = path.join(vaultPath, assessment.path);
          await fs.unlink(fullPath);
        } catch (error) {
          errors.push(`Failed to remove ${assessment.path}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
    }

    // 2. Merge duplicate groups
    const agent = mastra.getAgent('notesAgent');

    for (const group of (input?.duplicateGroups || []) as DuplicateGroup[]) {
      try {
        const mergedContent = await mergeNotesWithAI(group, agent);
        const action = `Merge ${group.duplicates.length} duplicates into ${group.primaryNote.path}`;
        actions.push(action);

        if (input?.options?.verbose) {
          console.log(`  ${action}`);
        }

        if (!input?.options?.dryRun) {
          // Update primary note with merged content
          await fs.writeFile(group.primaryNote.fullPath, mergedContent, 'utf8');

          // Remove duplicate files
          for (const duplicate of group.duplicates) {
            await fs.unlink(duplicate.fullPath);
          }
        }

        // Add merged note to processed notes
        const mergedNote: Note = { ...group.primaryNote };
        if (!input?.options?.dryRun) {
          const parsedContent = matter(mergedContent);
          mergedNote.body = parsedContent.content;
        }
        processedNotes.push(mergedNote);

      } catch (error) {
        errors.push(`Failed to merge group ${group.primaryNote.path}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    return {
      processedNotes,
      actions,
      errors,
      options: input?.options
    };
  }
});

// Step 5: Add AI-generated summaries
const addSummariesStep = createStep({
  id: "add-summaries",
  description: "Add AI-generated summaries and enhanced metadata",
  inputSchema: z.object({
    processedNotes: z.array(NoteSchema),
    actions: z.array(z.string()),
    errors: z.array(z.string()),
    options: OptionsSchema
  }),
  outputSchema: ReorganizeOutputSchema,
  execute: async (context: any) => {
    const { inputData: input, mastra } = context;
    const actions: string[] = input?.actions || [];
    const errors: string[] = input?.errors || [];
    const processedNotes: Note[] = input?.processedNotes || [];

    if (!input?.options?.addSummaries) {
      return {
        notesAnalyzed: processedNotes.length,
        lowQualityRemoved: actions.filter((a: string) => a.includes('Remove')).length,
        duplicatesFound: actions.filter((a: string) => a.includes('Merge')).length,
        duplicatesMerged: actions.filter((a: string) => a.includes('Merge')).length,
        summariesAdded: 0,
        actions,
        errors
      };
    }

    console.log("📝 Adding AI-generated summaries...");

    const agent = mastra.getAgent('notesAgent');
    if (!agent) {
      console.log("Notes agent not available for summary generation");
      return {
        notesAnalyzed: processedNotes.length,
        lowQualityRemoved: actions.filter((a: string) => a.includes('Remove')).length,
        duplicatesFound: actions.filter((a: string) => a.includes('Merge')).length,
        duplicatesMerged: actions.filter((a: string) => a.includes('Merge')).length,
        summariesAdded: 0,
        actions,
        errors
      };
    }

    let summariesAdded = 0;
    const updatedActions = [...actions];
    const updatedErrors = [...errors];

    for (const note of processedNotes) {
      try {
        if (await needsSummary(note)) {
          const summary = await generateSummary(note, agent);
          const action = `Add AI summary to: ${note.path}`;
          updatedActions.push(action);

          if (input?.options?.verbose) {
            console.log(`  ${action}`);
          }

          if (!input?.options?.dryRun) {
            await addSummaryToNote(note, summary);
          }

          summariesAdded++;
        }
      } catch (error) {
        updatedErrors.push(`Failed to add summary to ${note.path}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    return {
      notesAnalyzed: processedNotes.length,
      lowQualityRemoved: actions.filter((a: string) => a.includes('Remove')).length,
      duplicatesFound: actions.filter((a: string) => a.includes('Merge')).length,
      duplicatesMerged: actions.filter((a: string) => a.includes('Merge')).length,
      summariesAdded,
      actions: updatedActions,
      errors: updatedErrors
    };
  }
});

// Create the reorganize workflow
export const reorganizeWorkflow = createWorkflow({
  id: "reorganize-workflow",
  description: "AI-powered notes reorganization workflow",
  inputSchema: ReorganizeInputSchema,
  outputSchema: ReorganizeOutputSchema
})
  .then(loadNotesStep)
  .then(qualityAssessmentStep)
  .then(duplicateDetectionStep)
  .then(executeChangesStep)
  .then(addSummariesStep)
  .commit();

// Helper functions

async function mergeNotesWithAI(group: DuplicateGroup, agent: any): Promise<string> {
  const prompt = `Merge these duplicate notes into a single, well-organized note. Combine all unique information while removing redundancy.

Primary Note:
Title: ${group.primaryNote.title}
Content: ${group.primaryNote.body}

Duplicate Notes:
${group.duplicates.map((note: Note, idx: number) => `
Note ${idx + 1}:
Title: ${note.title}
Content: ${note.body}
`).join('')}

Create a merged note that:
- Keeps the best title
- Combines all unique information
- Removes redundant content
- Maintains logical organization
- Preserves important details from all notes

Return the complete markdown file content including frontmatter:`;

  const response = await agent.generate([{ role: 'user', content: prompt }]);

  // Ensure proper frontmatter structure
  const mergedContent = response.text || '';
  if (!mergedContent.startsWith('---')) {
    // Add frontmatter if missing
    const frontMatter = {
      title: group.primaryNote.title,
      date: group.primaryNote.date,
      modified: new Date().toISOString(),
      tags: [...new Set([...group.primaryNote.tags, ...group.duplicates.flatMap((d: Note) => d.tags)])],
      source: group.primaryNote.source,
      merged_from: group.duplicates.map((d: Note) => d.path)
    };

    return matter.stringify(mergedContent, frontMatter);
  }

  return mergedContent;
}

async function needsSummary(note: Note): Promise<boolean> {
  try {
    const fileContent = await fs.readFile(note.fullPath, 'utf8');
    const frontMatter = matter(fileContent);

    return (
      !frontMatter.data.summary &&
      note.body.length > 200 &&
      note.body.trim().length > 0
    );
  } catch (error) {
    console.error(`Failed to check if note needs summary: ${note.path}`, error instanceof Error ? error.message : 'Unknown error');
    return false;
  }
}

async function generateSummary(note: Note, agent: any): Promise<string> {
  const prompt = `Create a concise 1-2 sentence summary of this note:

Title: ${note.title}
Content: ${note.body.substring(0, 1000)}

Summary should capture the main topic and key points:`;

  const response = await agent.generate([{ role: 'user', content: prompt }]);
  return response.text?.trim() || 'AI-generated summary unavailable';
}

async function addSummaryToNote(note: Note, summary: string): Promise<void> {
  const fileContent = await fs.readFile(note.fullPath, 'utf8');
  const { data, content } = matter(fileContent);

  const updatedFrontMatter = {
    ...data,
    summary,
    auto_summary_generated: new Date().toISOString(),
    word_count: content.split(/\s+/).length,
    modified: new Date().toISOString()
  };

  const updatedFileContent = matter.stringify(content, updatedFrontMatter);
  await fs.writeFile(note.fullPath, updatedFileContent, 'utf8');
}
