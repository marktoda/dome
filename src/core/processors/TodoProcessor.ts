import { FileProcessor, FileEvent, FileEventType } from './FileProcessor.js';
import { getTodoPath, parseTodoMarkdown, buildTodoMarkdown, Task } from '../utils/todo.js';
import { mastra } from '../../mastra/index.js';
import fs from 'node:fs/promises';
import logger from '../utils/logger.js';

export class TodoProcessor extends FileProcessor {
  readonly name = 'TodoExtractor';

  protected async processFile(event: FileEvent): Promise<void> {
    const { type, path: filePath, relativePath } = event;

    if (type === FileEventType.Deleted) {
      await this.removeNoteTodos(relativePath);
      return;
    }

    logger.info(`[TODOProcessor] Looking for todos in: ${relativePath}`);

    // Read file content
    const content = await fs.readFile(filePath, 'utf-8');

    // Use Mastra workflow to extract todos with LLM
    const tasks = await this.extractTodosWithLLM(content, relativePath);

    await this.updateCentralTodoList(relativePath, tasks);

    if (tasks.length > 0) {
      logger.info(`[TODOProcessor] Extracted ${tasks.length} todo(s) from ${relativePath}`);
    }
  }

  private async extractTodosWithLLM(content: string, noteId: string): Promise<Task[]> {
    try {
      // Execute the parseTodos workflow
      const workflow = mastra.getWorkflow('parseTodosWorkflow');

      if (!workflow) {
        logger.error('[TODOProcessor] parseTodos workflow not found in Mastra');
        return [];
      }

      const run = await workflow.createRunAsync();
      const result = await run.start({
        inputData: {
          content,
          filePath: noteId,
        }
      });

      if (result.status !== 'success') {
        logger.error(`[TODOProcessor] Workflow failed: ${result.status}`);
        return [];
      }

      // Convert workflow todos to our Task format
      const tasks: Task[] = result.result.todos.map((todo: any) => ({
        text: todo.text,
        status: todo.status as 'pending' | 'in-progress' | 'done',
        from: noteId,
      }));

      if (result.result.totalFound > 0) {
        logger.debug(`[TODOProcessor] LLM found ${result.result.totalFound} todos: ${result.result.reasoning}`);
      }

      return tasks;
    } catch (error) {
      logger.error(`[TODOProcessor] Failed to extract todos with LLM: ${error}`);
      return [];
    }
  }

  private async updateCentralTodoList(noteId: string, newTasks: Task[]): Promise<void> {
    const todoPath = await getTodoPath();

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
