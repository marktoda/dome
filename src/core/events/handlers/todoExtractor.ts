import { NoteCreatedEvent, NoteUpdatedEvent, NoteRemovedEvent } from '../types.js';
import { 
  getTodoPath, 
  parseTodoMarkdown, 
  buildTodoMarkdown,
  Task
} from '../../utils/todo.js';
import { NoteService } from '../../services/NoteService.js';
import logger from '../../utils/logger.js';
import fs from 'node:fs/promises';

const TODO_PATTERNS = [
  /^[-*]\s*\[\s*\]\s+(.+)$/gm,      // - [ ] task
  /^[-*]\s*\[\s*\]\s+(.+)$/gm,      // * [ ] task  
  /^TODO:\s*(.+)$/gim,               // TODO: task
  /^FIXME:\s*(.+)$/gim,              // FIXME: task
];

function extractTodosFromContent(content: string, noteId: string): Task[] {
  const tasks: Task[] = [];
  
  for (const pattern of TODO_PATTERNS) {
    const matches = content.matchAll(pattern);
    for (const match of matches) {
      const text = match[1].trim();
      if (text) {
        tasks.push({
          text,
          status: 'pending',
          from: noteId
        });
      }
    }
  }
  
  return tasks;
}

async function updateCentralTodoList(noteId: string, newTasks: Task[]): Promise<void> {
  const todoPath = getTodoPath();
  
  // Read existing todos
  let existingTasks: Task[] = [];
  try {
    const content = await fs.readFile(todoPath, 'utf-8');
    existingTasks = parseTodoMarkdown(content);
  } catch (err) {
    // File doesn't exist yet, that's ok
    logger.debug('No existing todo.md file, will create one');
  }
  
  // Remove old tasks from this note
  const filteredTasks = existingTasks.filter(t => t.from !== noteId);
  
  // Add new tasks from this note
  const updatedTasks = [...filteredTasks, ...newTasks];
  
  // Write back
  const markdown = buildTodoMarkdown(updatedTasks);
  await fs.writeFile(todoPath, markdown, 'utf-8');
  
  logger.info(`Updated todo.md: removed ${existingTasks.length - filteredTasks.length} old tasks, added ${newTasks.length} new tasks from ${noteId}`);
}

export async function handleTodoExtraction(
  event: NoteCreatedEvent | NoteUpdatedEvent
): Promise<void> {
  try {
    const content = 'newContent' in event ? event.newContent : event.content;
    const tasks = extractTodosFromContent(content, event.noteId);
    
    if (tasks.length > 0) {
      await updateCentralTodoList(event.noteId, tasks);
      logger.debug(`Extracted ${tasks.length} TODO(s) from ${event.noteId}`);
    } else {
      // Still update to remove any old todos from this note
      await updateCentralTodoList(event.noteId, []);
      logger.debug(`No TODOs found in ${event.noteId}, cleaned up old entries`);
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'unknown error';
    logger.error(`TODO extraction failed for ${event.noteId}: ${errorMsg}`);
    // Don't throw - this is a non-critical enhancement
  }
}

export async function handleTodoRemoval(event: NoteRemovedEvent): Promise<void> {
  try {
    // Remove all todos from this note
    await updateCentralTodoList(event.noteId, []);
    logger.debug(`Removed TODOs for deleted note: ${event.noteId}`);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'unknown error';
    logger.error(`TODO removal failed for ${event.noteId}: ${errorMsg}`);
    // Don't throw - this is a non-critical enhancement
  }
}