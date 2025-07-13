/**
 * Registry of default context templates
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readContextFile } from './parser.js';
import type { DomeContext } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const templatesDir = join(__dirname, 'templates');

export interface ContextTemplate {
  id: string;
  name: string;
  description: string;
  context: DomeContext;
}

/**
 * Load all default context templates
 */
export async function loadDefaultTemplates(): Promise<ContextTemplate[]> {
  const templateFiles = [
    { id: 'meetings', file: 'meetings.dome' },
    { id: 'journal', file: 'journal.dome' },
    { id: 'projects', file: 'projects.dome' },
    { id: 'ideas', file: 'ideas.dome' },
    { id: 'reading', file: 'reading.dome' },
  ];
  
  const templates: ContextTemplate[] = [];
  
  for (const { id, file } of templateFiles) {
    const path = join(templatesDir, file);
    const context = await readContextFile(path);
    
    if (context) {
      templates.push({
        id,
        name: context.name,
        description: context.description,
        context,
      });
    }
  }
  
  return templates;
}

/**
 * Get a specific template by ID
 */
export async function getTemplate(templateId: string): Promise<ContextTemplate | null> {
  const templates = await loadDefaultTemplates();
  return templates.find(t => t.id === templateId) || null;
}

/**
 * Generate a custom context based on user description
 */
export function generateCustomContext(description: string, folderName: string): DomeContext {
  // Simple heuristic-based generation
  // In a real implementation, this could use AI
  
  const name = folderName
    .split(/[-_]/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
  
  const isTimeBasedFolder = /daily|journal|log/i.test(folderName);
  const isProjectFolder = /project|task|work/i.test(folderName);
  
  const context: DomeContext = {
    name,
    description,
    template: {
      frontmatter: {},
      content: `# {title}\n\n`,
    },
    rules: {
      fileNaming: isTimeBasedFolder ? 'YYYY-MM-DD-{title}' : '{title}',
      autoTags: [folderName.toLowerCase()],
    },
  };
  
  // Add specific fields based on folder type
  if (isProjectFolder) {
    context.template!.frontmatter = {
      status: 'active',
      created: '{date}',
    };
    context.rules!.requiredFields = ['status'];
  }
  
  if (isTimeBasedFolder) {
    context.template!.frontmatter = {
      date: '{date}',
    };
  }
  
  return context;
}