import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeSaveHook, NoteSaveContext } from '../note-hooks.js';
import logger from '../../../utils/logger.js';
import { config } from '../../config.js';
import { z } from 'zod';
import { mastra } from '../../../index.js';

// Absolute path to the central TODO list inside the vault
const TODO_FILE = path.join(config.DOME_VAULT_PATH, 'todo.md');

// -------------------------
// LLM extraction helpers
// -------------------------

const TasksSchema = z.object({
  tasks: z.array(z.string()).describe('one todo item per element'),
});

async function extractOpenTasksLLM(markdown: string): Promise<string[]> {
  const agent = mastra.getAgent('tasksAgent');
  if (!agent) {
    return naiveExtract(markdown);
  }

  const prompt = /* md */ `Extract all OPEN tasks from the following Markdown note. Return strictly JSON per schema.

NOTE START
${markdown}
NOTE END`;

  try {
    const result = await agent.generate([{ role: 'user', content: prompt }], {
      experimental_output: TasksSchema,
    });

    if (result.object) {
      return result.object.tasks;
    }
    logger.warn('⚠️  tasksAgent returned no object – fallback to naive');
    return naiveExtract(markdown);
  } catch (err) {
    logger.warn(`⚠️  tasksAgent extraction failed: ${err instanceof Error ? err.message : 'unknown'}`);
    return naiveExtract(markdown);
  }
}

// simple fallback regex extractor
function naiveExtract(markdown: string): string[] {
  const tasks: string[] = [];
  const lines = markdown.split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*[-*]\s+\[\s*\]\s+(.+)/);
    if (m) tasks.push(m[1].trim());
  }
  return tasks;
}

/**
 * Update `todo.md`, keeping tasks grouped by originating note.
 * For simplicity we store each task on its own line with a backlink:
 *   - [ ] Buy milk <!-- from: projects/grocery.md -->
 */
async function upsertTasks(relPath: string, newTasks: string[]): Promise<void> {
  // Read current todo file (ignore if missing)
  let existing = '';
  try {
    existing = await fs.readFile(TODO_FILE, 'utf8');
  } catch {
    /* file might not exist – that's fine */
  }

  const byLine = existing.split('\n');
  const tag = `from: ${relPath}`;

  // Remove any previous task lines for this note
  const filtered = byLine.filter(l => !l.includes(tag));

  // Append freshly extracted tasks
  for (const task of newTasks) {
    filtered.push(`- [ ] ${task} <!-- ${tag} -->`);
  }

  const nextContent = filtered.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';

  await fs.writeFile(TODO_FILE, nextContent, 'utf8');
}

/* -----------------------------------------------------------
 * Hook registration
 * ---------------------------------------------------------*/

async function todoExtractImpl(ctx: NoteSaveContext): Promise<void> {
  try {
    const tasks = await extractOpenTasksLLM(ctx.raw);
    await upsertTasks(ctx.relPath, tasks);
  } catch (err) {
    logger.warn(
      `⚠️  todo-extract hook failed: ${err instanceof Error ? err.message : 'unknown'}`
    );
  }
}

export const todoExtractHook = beforeSaveHook(
  'Extract TODOs',
  todoExtractImpl,
  'Extract open tasks from note and update central todo list'
); 