import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeSaveHook, NoteSaveContext } from '../note-hooks.js';
import logger from '../../../utils/logger.js';
import { config } from '../../config.js';
import { z } from 'zod';
import { mastra } from '../../../index.js';
import { promptService, PromptName } from '../../../prompts/prompt-service.js';
import {
  parseTodoMarkdown,
  buildTodoMarkdown,
  tasksToLists,
  listsToTasks,
  Task,
  TaskStatus,
} from '../../../utils/todo.js';

// Absolute path to the central TODO list inside the vault
const TODO_FILE = path.join(config.DOME_VAULT_PATH, 'todo.md');

// -------------------------
// Schema definitions
// -------------------------

interface ExtractedTask {
  text: string;
  status: TaskStatus;
}

const ExtractedTaskSchema = z.object({
  text: z.string().describe('task text without checkbox'),
  status: z.enum(['pending', 'in-progress', 'done']).describe('current status'),
});

const TasksSchema = z.object({
  tasks: z.array(ExtractedTaskSchema).describe('tasks with status'),
});

const MergeSchema = z.object({
  pending: z.array(z.object({ text: z.string(), from: z.string() })),
  inProgress: z.array(z.object({ text: z.string(), from: z.string() })),
  done: z.array(z.object({ text: z.string(), from: z.string() })),
});

// -------------------------
// Core functions
// -------------------------

/**
 * Extract tasks from markdown content using LLM
 */
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
 * Merge extracted tasks into the central todo.md file
 * Preserves tasks from other notes and maintains backlinks
 */
async function mergeTasksIntoTodoFile(relPath: string, extracted: ExtractedTask[]): Promise<void> {
  const agent = mastra.getAgent('tasksAgent');
  if (!agent) throw new Error('tasksAgent not registered');

  // Ensure "from" is set on each incoming task so we can maintain backlink
  const incomingTasks: Task[] = extracted.map(t => ({ 
    text: t.text,
    status: t.status,
    from: relPath 
  }));

  // Load and parse existing todo.md
  let existingMarkdown = '';
  try {
    existingMarkdown = await fs.readFile(TODO_FILE, 'utf8');
  } catch (err) {
    // File doesn't exist yet, which is fine
    logger.debug('todo.md does not exist yet, will create');
  }

  const currentTasks = parseTodoMarkdown(existingMarkdown);
  const currentLists = tasksToLists(currentTasks);

  // Use LLM to intelligently merge tasks
  const mergePrompt = promptService.render(PromptName.UpdateTodoLists, {
    existingListsJson: JSON.stringify(currentLists, null, 2),
    relPath,
    noteTasksJson: JSON.stringify(incomingTasks, null, 2),
  });

  const res = await agent.generate([{ role: 'user', content: mergePrompt }], {
    experimental_output: MergeSchema,
  });

  if (!res.object) throw new Error('tasksAgent returned no lists');

  // Convert the merged lists back to tasks and build markdown
  const mergedTasks = listsToTasks(res.object as any);
  const newMarkdown = buildTodoMarkdown(mergedTasks);

  // Ensure directory exists
  await fs.mkdir(path.dirname(TODO_FILE), { recursive: true });
  
  // Write the updated todo file
  await fs.writeFile(TODO_FILE, newMarkdown, 'utf8');
  logger.info(`✅ Updated todo.md with ${extracted.length} tasks from ${relPath}`);
}

// -------------------------
// Hook implementation
// -------------------------

async function todoExtractImpl(ctx: NoteSaveContext): Promise<void> {
  try {
    const source = ctx.originalRaw ?? ctx.currentRaw;

    // Skip if content is too short to contain meaningful tasks
    if (!source || source.length < 10) {
      return;
    }

    const tasks = await extractTasksLLM(source);
    
    if (tasks.length === 0) {
      logger.debug(`No tasks found in ${ctx.relPath}`);
      return;
    }

    await mergeTasksIntoTodoFile(ctx.relPath, tasks);
  } catch (err) {
    // Don't fail the save operation due to todo extraction errors
    logger.warn(
      `⚠️  todo-extract hook failed for ${ctx.relPath}: ${err instanceof Error ? err.message : 'unknown error'}`
    );
  }
}

// -------------------------
// Hook registration
// -------------------------

export const todoExtractHook = beforeSaveHook(
  'Extract TODOs',
  todoExtractImpl,
  'Extract open tasks from note and update central todo list'
); 