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

const TasksSchema = z.object({
  tasks: z.array(z.string()).describe('one pending todo item per element'),
});

async function extractTasksLLM(markdown: string): Promise<ExtractedTask[]> {
  const agent = mastra.getAgent('tasksAgent');
  if (!agent) {
    return naiveExtract(markdown);
  }

  const prompt = promptService.render(PromptName.ExtractOpenTasks, {
    markdown,
  });

  try {
    const result = await agent.generate([{ role: 'user', content: prompt }], {
      experimental_output: TasksSchema,
    });

    if (result.object) {
      return result.object.tasks.map(t => ({ text: t, status: 'pending' }));
    }
    logger.warn('⚠️  tasksAgent returned no object – fallback to naive');
    return naiveExtract(markdown);
  } catch (err) {
    logger.warn(`⚠️  tasksAgent extraction failed: ${err instanceof Error ? err.message : 'unknown'}`);
    return naiveExtract(markdown);
  }
}

// simple fallback regex extractor (handles status)
function naiveExtract(markdown: string): ExtractedTask[] {
  const tasks: ExtractedTask[] = [];
  const lines = markdown.split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*[-*]\s+\[([ x\/])\]\s+(.+)/i);
    if (m) {
      const mark = m[1].toLowerCase();
      const text = m[2].trim();
      let status: TaskStatus = 'pending';
      if (mark === 'x') status = 'done';
      else if (mark === '/') status = 'in-progress';
      tasks.push({ text, status });
    }
  }
  return tasks;
}

/**
 * Update `todo.md`, keeping tasks grouped by originating note.
 * For simplicity we store each task on its own line with a backlink:
 *   - [ ] Buy milk <!-- from: projects/grocery.md -->
 */
async function upsertTasks(relPath: string, newTasks: ExtractedTask[]): Promise<void> {
  // Read current todo file (ignore if missing)
  let existing = '';
  try {
    existing = await fs.readFile(TODO_FILE, 'utf8');
  } catch {
    /* file might not exist – that's fine */
  }

  const tag = `from: ${relPath}`;

  // Helper containers for each section
  const sections: Record<TaskStatus, string[]> = {
    pending: [],
    'in-progress': [],
    done: [],
  };

  // Parse existing content & keep tasks not belonging to this note
  const parseLine = (line: string, status: TaskStatus) => {
    if (!line.includes(tag)) sections[status].push(line);
  };

  const lines = existing.split('\n');
  let current: TaskStatus | null = null;
  for (const line of lines) {
    const headerMatch = line.match(/^##\s+(.*)/i);
    if (headerMatch) {
      const title = headerMatch[1].toLowerCase();
      if (title.startsWith('pending')) current = 'pending';
      else if (title.includes('progress')) current = 'in-progress';
      else if (title.startsWith('done')) current = 'done';
      else current = null;
      continue;
    }

    const taskMatch = line.match(/^\s*[-*]\s+\[([ x\/])\]/i);
    if (taskMatch && current) {
      parseLine(line, current);
    }
  }

  // Append freshly extracted tasks in the correct section
  const statusChar: Record<TaskStatus, string> = {
    pending: ' ',
    'in-progress': '/',
    done: 'x',
  };

  for (const task of newTasks) {
    const line = `- [${statusChar[task.status]}] ${task.text} <!-- ${tag} -->`;
    sections[task.status].push(line);
  }

  // Sort tasks alphabetically within each section for cleanliness
  (Object.keys(sections) as TaskStatus[]).forEach(key => {
    sections[key].sort((a, b) => a.localeCompare(b));
  });

  // Reconstruct file
  const buildSection = (title: string, linesArr: string[]): string => {
    return [`## ${title}`, ...linesArr, ''].join('\n');
  };

  const nextContent = [
    '# TODO',
    '',
    buildSection('Pending', sections.pending),
    buildSection('In Progress', sections['in-progress']),
    buildSection('Done', sections.done),
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd() + '\n';

  await fs.writeFile(TODO_FILE, nextContent, 'utf8');
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