import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeSaveHook, NoteSaveContext } from '../note-hooks.js';
import logger from '../../../utils/logger.js';
import { config } from '../../config.js';
import { z } from 'zod';
import { mastra } from '../../../index.js';
import { promptService, PromptName } from '../../../prompts/prompt-service.js';

// Absolute path to the central TODO list inside the vault
const TODO_FILE = path.join(config.DOME_VAULT_PATH, 'todo.md');

type TaskStatus = 'pending' | 'in-progress' | 'done';

interface ExtractedTask {
  text: string;
  status: TaskStatus;
}

// -------------------------
// LLM extraction helpers
// -------------------------

const ExtractedTaskSchema = z.object({
  text: z.string().describe('task text without checkbox'),
  status: z.enum(['pending', 'in-progress', 'done']).describe('current status'),
});

const TasksSchema = z.object({
  tasks: z.array(ExtractedTaskSchema).describe('tasks with status'),
});

async function extractTasksLLM(markdown: string): Promise<ExtractedTask[]> {
  const agent = mastra.getAgent('tasksAgent');
  if (!agent) {
    throw new Error('tasksAgent is not registered – cannot extract tasks');
  }

  const prompt = promptService.render(PromptName.ExtractOpenTasks, {
    markdown,
  });

  const result = await agent.generate([{ role: 'user', content: prompt }], {
    experimental_output: TasksSchema,
  });

  if (!result.object) {
    throw new Error('tasksAgent returned no tasks');
  }

  return result.object.tasks;
}

/**
 * Update `todo.md`, keeping tasks grouped by originating note.
 * For simplicity we store each task on its own line with a backlink:
 *   - [ ] Buy milk <!-- from: projects/grocery.md -->
 */
async function upsertTasks(relPath: string, newTasks: ExtractedTask[]): Promise<void> {
  // Ensure the dedicated agent is available
  const agent = mastra.getAgent('tasksAgent');
  if (!agent) {
    throw new Error('tasksAgent is not registered – cannot update todo.md');
  }

  // Load the current todo.md (empty string if missing)
  let existing = '';
  try {
    existing = await fs.readFile(TODO_FILE, 'utf8');
  } catch {
    /* file might not exist – that's okay */
  }

  // Build prompt and ask the LLM to merge
  const TodoUpdateSchema = z.object({ markdown: z.string().describe('updated todo.md content') });

  const updatePrompt = promptService.render(PromptName.UpdateTodoFile, {
    existing,
    relPath,
    tasksJson: JSON.stringify(newTasks, null, 2),
  });

  const res = await agent.generate([{ role: 'user', content: updatePrompt }], {
    experimental_output: TodoUpdateSchema,
  });

  const md = res.object?.markdown;
  if (!md?.trim()) {
    throw new Error('tasksAgent returned empty todo.md content');
  }

  await fs.writeFile(TODO_FILE, md.trimEnd() + '\n', 'utf8');
}

/* -----------------------------------------------------------
 * Hook registration
 * ---------------------------------------------------------*/

async function todoExtractImpl(ctx: NoteSaveContext): Promise<void> {
  try {
    const tasks = await extractTasksLLM(ctx.raw);
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