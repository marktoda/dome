import { config } from '../../core/utils/config.js';
import path from 'node:path';

export type TaskStatus = 'pending' | 'in-progress' | 'done';

export interface Task {
  text: string;
  status: TaskStatus;
  from: string;
}

export function getTodoPath(): string {
  return path.join(config.DOME_VAULT_PATH, 'todo.md');
}

// Simple regex for checkbox tasks with optional backlink
const TASK_REGEX = /^[-*]\s*\[(.)\]\s*(.*?)(?:\s*<!--\s*from:\s*(.+?)\s*-->)?$/;

// Status mappings
const CHECKBOX_STATUS: Record<string, TaskStatus> = {
  'x': 'done',
  'X': 'done',
  '✓': 'done', 
  '✔': 'done',
  '/': 'in-progress',
  '-': 'in-progress'
};

const SECTION_STATUS: Record<string, TaskStatus> = {
  'pending': 'pending',
  'in progress': 'in-progress',
  'in-progress': 'in-progress', 
  'done': 'done',
  'completed': 'done'
};

export function parseTodoMarkdown(markdown: string): Task[] {
  const tasks: Task[] = [];
  let currentSection: TaskStatus | null = null;

  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    
    // Section headers
    if (trimmed.startsWith('## ')) {
      currentSection = SECTION_STATUS[trimmed.slice(3).toLowerCase()] || null;
      continue;
    }

    // Task lines
    const match = line.match(TASK_REGEX);
    if (match && currentSection) {
      const [, checkbox, text, from] = match;
      const taskText = text.trim();
      
      if (taskText) {
        const status = CHECKBOX_STATUS[checkbox] || currentSection;
        tasks.push({ 
          text: taskText, 
          status, 
          from: from?.trim() || 'manual' 
        });
      }
    }
  }

  return tasks;
}

// Status to checkbox mapping
const STATUS_CHECKBOX: Record<TaskStatus, string> = {
  'pending': '[ ]',
  'in-progress': '[/]', 
  'done': '[x]'
};

export function formatTaskLine(task: Task): string {
  const checkbox = STATUS_CHECKBOX[task.status];
  const backlink = task.from === 'manual' ? '' : ` <!-- from: ${task.from} -->`;
  return `- ${checkbox} ${task.text}${backlink}`;
}

export function buildTodoMarkdown(tasks: Task[]): string {
  const sections = [
    { title: 'Pending', status: 'pending' as TaskStatus },
    { title: 'In Progress', status: 'in-progress' as TaskStatus },
    { title: 'Done', status: 'done' as TaskStatus }
  ];

  const lines = ['# TODO', ''];
  
  for (const { title, status } of sections) {
    lines.push(`## ${title}`, '');
    const sectionTasks = tasks.filter(t => t.status === status);
    
    if (sectionTasks.length === 0) {
      lines.push('_No tasks_');
    } else {
      sectionTasks.forEach(task => lines.push(formatTaskLine(task)));
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}
