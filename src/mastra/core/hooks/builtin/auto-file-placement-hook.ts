import { join, extname } from 'node:path';
import { z } from 'zod';
import { afterSaveHook, NoteSaveContext } from '../note-hooks.js';
import { mastra } from '../../../index.js';
import { promptService, PromptName } from '../../../prompts/prompt-service.js';
import logger from '../../../utils/logger.js';
import { noteStore, NoteId } from '../../note-store.js';
import { toRel, toAbs } from '../../../utils/path-utils.js';

// -------------------------------------------------------------
// Zod schema reused from NoteManager.autoCategorize
// -------------------------------------------------------------
const CategorizeSchema = z.object({
  title: z.string().min(1).describe('Proposed title for the note'),
  folderPath: z
    .string()
    .min(1)
    .describe("Relative vault folder ending with '/' e.g. 'projects/'"),
  fileName: z.string().min(1).describe('File name with .md extension'),
  reasoning: z.string().optional(),
});

async function autoPlacementImpl(ctx: NoteSaveContext): Promise<void> {
  // We need the AI agent; bail if unavailable
  const agent = mastra.getAgent('notesAgent');
  if (!agent) {
    logger.debug('notesAgent not registered – skipping auto placement');
    return;
  }

  if (!ctx.raw?.trim()) return; // nothing to analyse

  // --- 1. Ask the LLM for an ideal location/filename
  const prompt = promptService.render(PromptName.AutoCategorizeNote, {
    content: ctx.raw.trim().slice(0, 4000),
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
    logger.warn(`⚠️  Auto placement hook failed: ${err instanceof Error ? err.message : 'unknown'}`);
    return;
  }

  // If suggestion equals current location, nothing to do
  if (targetRel === ctx.relPath) return;

  const isNew = ctx.existedBefore === false;
  const isInbox = ctx.relPath.startsWith('inbox/');

  // --- 2. Decide whether to apply or just log
  if (isNew && isInbox) {
    // Safe to move/rename
    const renameRes = await noteStore.rename(ctx.relPath as NoteId, targetRel as NoteId);
    if (!renameRes.success) {
      logger.warn(`⚠️  Auto placement failed: ${renameRes.message}`);
      return;
    }

    logger.info(`📁 ${renameRes.message}`);

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
  'Automatically categorises new inbox notes and moves/renames them'
); 