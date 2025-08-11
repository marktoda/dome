import fs from 'node:fs/promises';
import logger from '../../mastra/utils/logger.js';
import readline from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import {
  parseTodoMarkdown,
  buildTodoMarkdown,
  getTodoPath,
  Task,
  TaskStatus,
} from '../../mastra/utils/todo.js';

// We augment Task with a runtime id used only for the interactive prompt
interface IndexedTask extends Task {
  id: number;
}

/**
 * Display the current open tasks (pending + in-progress) and allow the user to
 * update their status.
 */
export async function handleTodo(): Promise<void> {
  try {
    const todoPath = getTodoPath();

    // Read existing file (or create default structure in memory)
    let markdown = '';
    try {
      markdown = await fs.readFile(todoPath, 'utf8');
    } catch {
      // File might not exist yet – we'll create it at the end if needed
      markdown = '# TODO\n\n## Pending\n\n## In Progress\n\n## Done\n';
    }

    let tasks = parseTodoMarkdown(markdown).map((t, idx) => ({ ...t, id: idx + 1 })) as IndexedTask[];

    if (tasks.length === 0) {
      logger.info('📭 No tasks found in your todo list.');
      return;
    }

    let modified = false;

    // Simple TUI using readline raw mode
    const rl = readline.createInterface({ input, output });
    // @ts-ignore - setRawMode exists on TTY streams
    if (input.isTTY) input.setRawMode(true);
    readline.emitKeypressEvents(input, rl);

    let cursor = 0;

    function render() {
      // Clear screen
      output.write('\x1Bc');
      output.write('TODOs – arrow keys to navigate, <space> to cycle status, <enter>/<q> to save & quit\n\n');
      tasks.forEach((t, idx) => {
        const pointer = idx === cursor ? '❯' : ' ';
        const checkbox = t.status === 'pending' ? ' ' : t.status === 'in-progress' ? '~' : 'x';
        output.write(`${pointer} ${t.id}. [${checkbox}] ${t.text} (${t.from})\n`);
      });
    }

    render();

    const keyHandler = (str: string, key: readline.Key) => {
      if (key.name === 'up') {
        cursor = (cursor - 1 + tasks.length) % tasks.length;
        render();
      } else if (key.name === 'down') {
        cursor = (cursor + 1) % tasks.length;
        render();
      } else if (key.name === 'space') {
        const task = tasks[cursor];
        task.status = task.status === 'pending' ? 'in-progress' : task.status === 'in-progress' ? 'done' : 'pending';
        modified = true;
        render();
      } else if (key.name === 'return' || key.name === 'q' || (key.ctrl && key.name === 'c')) {
        rl.off('keypress', keyHandler);
        rl.close();
      }
    };

    rl.on('keypress', keyHandler);

    await new Promise<void>(resolve => rl.on('close', () => resolve()));

    if (modified) {
      const newMarkdown = buildTodoMarkdown(tasks);
      await fs.writeFile(todoPath, newMarkdown, 'utf8');
      logger.info(`✅ todo.md updated at ${todoPath}`);
    } else {
      logger.info('ℹ️  No changes made');
    }
  } catch (err) {
    logger.error('❌ Failed to manage todo list:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
} 