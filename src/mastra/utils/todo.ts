import { config } from '../core/config.js';
import path from 'node:path';

export type TaskStatus = 'pending' | 'in-progress' | 'done';

export interface Task {
  text: string;
  status: TaskStatus;
  /** Backlink note path or "manual" */
  from: string;
}

/** Absolute path to the central todo.md */
export function getTodoPath(): string {
  return path.join(config.DOME_VAULT_PATH, 'todo.md');
}

/** 
 * Enhanced regex that matches various checkbox formats and backlink comments
 * Supports: [ ], [x], [X], [/], [-] and flexible spacing
 */
const TASK_LINE_REGEX = /^\s*[-*]\s*\[([^\]]*)\]\s*(.*?)\s*(?:<!--\s*from:\s*(.+?)\s*-->)?\s*$/;

/**
 * Parse todo.md content into structured tasks
 * Handles multiple checkbox formats and preserves backlinks
 */
export function parseTodoMarkdown(markdown: string): Task[] {
  const tasks: Task[] = [];
  let currentSection: TaskStatus | null = null;

  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trim();

    // Check for section headers
    if (line.startsWith('## ')) {
      const header = line.slice(3).toLowerCase();
      if (header.includes('pending')) {
        currentSection = 'pending';
      } else if (header.includes('in progress') || header.includes('in-progress')) {
        currentSection = 'in-progress';
      } else if (header.includes('done') || header.includes('completed')) {
        currentSection = 'done';
      } else {
        currentSection = null;
      }
      continue;
    }

    // Parse task lines
    const match = rawLine.match(TASK_LINE_REGEX);
    if (match && currentSection) {
      const checkbox = match[1].trim().toLowerCase();
      const text = match[2].trim();
      const from = match[3] ? match[3].trim() : 'manual';
      
      // Determine status from checkbox or use section default
      let status: TaskStatus = currentSection;
      
      // Override based on checkbox state
      if (checkbox === 'x' || checkbox === '✓' || checkbox === '✔') {
        status = 'done';
      } else if (checkbox === '/' || checkbox === '-') {
        status = 'in-progress';
      } else if (checkbox === '' || checkbox === ' ') {
        // Empty checkbox - use section status
        status = currentSection;
      }
      
      if (text) { // Only add if there's actual task text
        tasks.push({ text, status, from });
      }
    }
  }

  return tasks;
}

/**
 * Format a task into markdown line with proper checkbox and backlink
 */
export function formatTaskLine(task: Task): string {
  // Determine checkbox based on status
  let checkbox: string;
  switch (task.status) {
    case 'done':
      checkbox = '[x]';
      break;
    case 'in-progress':
      checkbox = '[/]';
      break;
    default:
      checkbox = '[ ]';
  }
  
  return task.from === 'manual'
    ? `- ${checkbox} ${task.text}`
    : `- ${checkbox} ${task.text} <!-- from: ${task.from} -->`;
}

/**
 * Build complete todo.md content from tasks array
 * Organizes tasks by status into sections
 */
export function buildTodoMarkdown(tasks: Task[]): string {
  const lines: string[] = [];
  lines.push('# TODO', '');

  const sections: Array<{ title: string; key: TaskStatus }> = [
    { title: 'Pending', key: 'pending' },
    { title: 'In Progress', key: 'in-progress' },
    { title: 'Done', key: 'done' },
  ];

  for (const { title, key } of sections) {
    lines.push(`## ${title}`, '');
    
    const sectionTasks = tasks.filter(t => t.status === key);
    if (sectionTasks.length === 0) {
      lines.push('_No tasks_', '');
    } else {
      sectionTasks.forEach(t => lines.push(formatTaskLine(t)));
      lines.push('');
    }
  }

  return lines.join('\n').trimEnd() + '\n';
}

export interface TaskLists {
  pending: Task[];
  inProgress: Task[];
  done: Task[];
}

export function tasksToLists(tasks: Task[]): TaskLists {
  return {
    pending: tasks.filter(t => t.status === 'pending'),
    inProgress: tasks.filter(t => t.status === 'in-progress'),
    done: tasks.filter(t => t.status === 'done'),
  };
}

export function listsToTasks(lists: TaskLists): Task[] {
  return [
    ...lists.pending.map(t => ({ ...t, status: 'pending' as const })),
    ...lists.inProgress.map(t => ({ ...t, status: 'in-progress' as const })),
    ...lists.done.map(t => ({ ...t, status: 'done' as const })),
  ];
} 