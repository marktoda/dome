import { FileProcessor, FileEvent, FileEventType } from './FileProcessor.js';
import { getTodoPath, parseTodoMarkdown, buildTodoMarkdown, Task } from '../utils/todo.js';
import fs from 'node:fs/promises';
import logger from '../utils/logger.js';

const TODO_PATTERNS = [
  /^[-*]\s*\[\s*\]\s+(.+)$/gm, // - [ ] task
  /^TODO:\s*(.+)$/gim, // TODO: task
  /^FIXME:\s*(.+)$/gim, // FIXME: task
];

export class TodoProcessor extends FileProcessor {
  readonly name = 'TodoExtractor';

  protected async processFile(event: FileEvent): Promise<void> {
    const { type, path: filePath, relativePath } = event;

    if (type === FileEventType.Deleted) {
      await this.removeNoteTodos(relativePath);
      return;
    }

    logger.info(`[TODOProcessor] Looking for todos in: ${relativePath}`);
    // For added or changed files, extract todos
    const content = await fs.readFile(filePath, 'utf-8');
    const tasks = this.extractTodos(content, relativePath);

    await this.updateCentralTodoList(relativePath, tasks);

    if (tasks.length > 0) {
      logger.info(`[TODOProcessor] Extracted ${tasks.length} todo(s) from ${relativePath}`);
    }
  }

  private extractTodos(content: string, noteId: string): Task[] {
    const tasks: Task[] = [];

    for (const pattern of TODO_PATTERNS) {
      // Reset the regex state for each use
      pattern.lastIndex = 0;
      const matches = content.matchAll(pattern);

      for (const match of matches) {
        const text = match[1].trim();
        if (text) {
          tasks.push({
            text,
            status: 'pending',
            from: noteId,
          });
        }
      }
    }

    return tasks;
  }

  private async updateCentralTodoList(noteId: string, newTasks: Task[]): Promise<void> {
    const todoPath = getTodoPath();

    // Read existing todos
    let existingTasks: Task[] = [];
    try {
      const content = await fs.readFile(todoPath, 'utf-8');
      existingTasks = parseTodoMarkdown(content);
    } catch (err) {
      // File doesn't exist yet, that's ok
      logger.debug('[TODOProcessor] No existing todo.md file, will create one');
    }

    // Remove old tasks from this note
    const filteredTasks = existingTasks.filter(t => t.from !== noteId);

    // Add new tasks from this note
    const updatedTasks = [...filteredTasks, ...newTasks];

    // Write back
    const markdown = buildTodoMarkdown(updatedTasks);
    await fs.writeFile(todoPath, markdown, 'utf-8');

    const removed = existingTasks.length - filteredTasks.length;
    const added = newTasks.length;

    if (removed > 0 || added > 0) {
      logger.debug(`[TODOProcessor] Updated todo.md: -${removed} +${added} tasks for ${noteId}`);
    }
  }

  private async removeNoteTodos(noteId: string): Promise<void> {
    await this.updateCentralTodoList(noteId, []);
    logger.debug(`[TODOProcessor] Removed todos for deleted note: ${noteId}`);
  }
}
