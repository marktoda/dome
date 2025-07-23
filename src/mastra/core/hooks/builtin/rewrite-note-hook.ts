import path from 'node:path';
import { mastra } from '../../../index.js';
import { ContextManager } from '../../context/manager.js';
import { NoteSaveContext } from '../note-hooks.js';
import { NoteId } from '../../note-store.js';
import { z } from 'zod';
import logger from '../../../utils/logger.js';

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

export async function rewriteNoteHook(ctx: NoteSaveContext): Promise<void> {
  // Bail early if no OpenAI key or agent missing (keeps flow fast for non-AI setups)
  if (!process.env.OPENAI_API_KEY) return;

  const agent = mastra.getAgent('readNotesAgent');
  if (!agent) return;

  const contextManager = new ContextManager();
  const folderContext = await contextManager.getContext(ctx.relPath as unknown as NoteId);

  const topic = topicFromPath(ctx.relPath);

  logger.info(`🤖 (hook) Cleaning up note: ${ctx.relPath}`);

  const rewritePrompt = /* md */ `
You are **Notes Agent**.
Goal → Rewrite the note below for clarity and structure while **preserving every important fact** and the existing YAML front-matter.

INPUTS
• **Topic**: "${topic}"
• **Vault-folder context (JSON)**:
${JSON.stringify(folderContext, null, 2)}

• **Current note markdown**:
${ctx.raw}

TASKS
1. Re-organize and clean the prose for readability.
2. Add logical Markdown headings / lists where helpful.
3. Keep the original front-matter unchanged and at the top.
4. DO NOT remove or truncate information unless explicitly instructed.
5. Respond **with nothing else** — only the valid JSON.
`;

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

// registration moved to central initialization
