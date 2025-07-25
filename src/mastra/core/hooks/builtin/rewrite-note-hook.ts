import path from 'node:path';
import { mastra } from '../../../index.js';
import { ContextManager } from '../../context/manager.js';
import { beforeSaveHook, NoteSaveContext } from '../note-hooks.js';
import { NoteId } from '../../note-store.js';
import { z } from 'zod';
import logger from '../../../utils/logger.js';
import { promptService, PromptName } from '../../../prompts/prompt-service.js';

// -------------------------------------------------------------
// Zod schema reused from NoteManager.rewriteNote
// -------------------------------------------------------------
const RewriteNoteSchema = z.object({
  noteText: z.string().describe('the full improved note, including front-matter metadata'),
  suggestedNoteFilename: z.string().describe('e.g. topic-key-points.md'),
  reasoning: z.string().optional(),
});

// Helper to generate a human-readable topic from the path
function topicFromPath(relPath: string): string {
  return path.basename(relPath, path.extname(relPath)).replace(/[-_]+/g, ' ');
}

async function rewriteNoteImpl(ctx: NoteSaveContext): Promise<void> {
  // Bail early if the agent is missing (keeps flow fast for non-AI setups)

  const agent = mastra.getAgent('readNotesAgent');
  if (!agent) return;

  const contextManager = new ContextManager();
  const folderContext = await contextManager.getContext(ctx.relPath as unknown as NoteId);

  const topic = topicFromPath(ctx.relPath);

  const rewritePrompt = promptService.render(PromptName.RewriteNote, {
    topic,
    folderContext: JSON.stringify(folderContext, null, 2),
    noteText: ctx.raw,
  });

  try {
    const res = await agent.generate([{ role: 'user', content: rewritePrompt }], {
      experimental_output: RewriteNoteSchema,
    });

    const obj = res.object;
    if (!obj?.noteText) return; // nothing to do

    const cleaned = obj.noteText.trim();
    if (cleaned && cleaned !== ctx.raw.trim()) {
      ctx.raw = cleaned; // mutate for note-store to write
      logger.info(`✅ Note cleaned and rewritten by AI${obj.reasoning ? ` – ${obj.reasoning}` : ''}`);
    }
  } catch (err) {
    logger.warn(`⚠️  AI cleanup hook failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }
}

// Expose as RegisteredHook object for registration in mastra/index.ts
export const rewriteNoteHook = beforeSaveHook(
  'Rewrite Note',
  rewriteNoteImpl,
  'AI-powered cleanup and restructuring of note before save'
);

// registration still happens centrally in mastra/index.ts
