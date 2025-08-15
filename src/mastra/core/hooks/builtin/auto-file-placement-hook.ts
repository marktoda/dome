import { join, extname } from 'node:path';
import { z } from 'zod';
import { afterSaveHook, NoteSaveContext } from '../note-hooks.js';
import { mastra } from '../../../index.js';
import { promptService, PromptName } from '../../../prompts/prompt-service.js';
import logger from '../../../../core/utils/logger.js';
import { NoteService, NoteId } from '../../../../core/services/NoteService.js';
import { toRel, toAbs } from '../../../../core/utils/path-utils.js';

// -------------------------------------------------------------
// Zod schema reused from NoteManager.autoCategorize
// -------------------------------------------------------------
const CategorizeSchema = z.object({
  title: z.string().min(1).describe('Proposed title for the note'),
  folderPath: z.string().min(1).describe("Relative vault folder ending with '/' e.g. 'projects/'"),
  fileName: z.string().min(1).describe('File name with .md extension'),
  reasoning: z.string().optional(),
});

async function autoPlacementImpl(ctx: NoteSaveContext): Promise<void> {
  const noteService = new NoteService();
  // We need the AI agent; bail if unavailable
  const agent = mastra.getAgent('notesAgent');
  if (!agent) {
    logger.debug('notesAgent not registered – skipping auto placement');
    return;
  }

  if (!ctx.currentRaw?.trim()) return; // nothing to analyse

  // --- 1. Ask the LLM for an ideal location/filename
  const prompt = promptService.render(PromptName.AutoCategorizeNote, {
    content: ctx.currentRaw.trim().slice(0, 4000),
  });

  let targetRel: NoteId;
  try {
    const result = await agent.generate([{ role: 'user', content: prompt }], {
      experimental_output: CategorizeSchema,
    });

    const obj = result.object;
    if (!obj) {
      logger.warn('⚠️  notesAgent returned no object – aborting auto placement');
      return;
    }

    // Build vault-relative destination path
    let p = join(obj.folderPath, obj.fileName);
    if (!extname(p)) p += '.md';
    targetRel = toRel(p) as NoteId;
  } catch (err) {
    logger.warn(
      `⚠️  Auto placement hook failed: ${err instanceof Error ? err.message : 'unknown'}`
    );
    return;
  }

  // If suggestion equals current location, nothing to do
  if (targetRel === ctx.relPath) return;

  const isInbox = ctx.relPath.startsWith('inbox/');

  // --- 2. Decide whether to apply or just log
  if (isInbox) {
    // Safe to move/rename
    await noteService.store.rename(ctx.relPath as NoteId, targetRel as NoteId);

    // Update context so subsequent hooks see the final location
    ctx.relPath = targetRel as NoteId;
    ctx.fullPath = toAbs(targetRel as NoteId);
    ctx.existedBefore = true;
  } else {
    // Only log recommendation (no move)
    logger.info(`💡 Suggested location for '${ctx.relPath}': ${targetRel}`);
  }
}

export const autoFilePlacementHook = afterSaveHook(
  'Auto File Placement',
  autoPlacementImpl,
  'Automatically categorises new inbox notes and moves/renames them',
  {
    id: 'auto-file-placement',
    priority: 10,
    pathIncludeGlobs: ['**/*.md', '**/*.markdown'],
  }
);
