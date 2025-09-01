import { FileProcessor, FileEvent, FileEventType } from './FileProcessor.js';
import { parseFrontmatter, FrontmatterData } from '../utils/frontmatter.js';
import { openai } from '@ai-sdk/openai';
import { generateObject } from 'ai';
import { z } from 'zod';
import { readFile, writeFile } from 'fs/promises';
import logger from '../utils/logger.js';
import path from 'path';

const FrontmatterSchema = z.object({
  title: z.string().optional().describe('A descriptive title for the document'),
  tags: z.array(z.string()).optional().describe('Relevant tags/categories for the content'),
  participants: z.array(z.string()).optional().describe('Names of people mentioned or involved'),
  summary: z.string().optional().describe('A brief 1-2 sentence summary'),
  description: z.string().optional().describe('A longer description of the content'),
  topics: z.array(z.string()).optional().describe('Main topics discussed'),
  date: z.string().optional().describe('Date in YYYY-MM-DD format if mentioned'),
  type: z.string().optional().describe('Type of document (meeting, note, article, etc)'),
  project: z.string().optional().describe('Related project name if applicable'),
  status: z.string().optional().describe('Status if applicable (draft, review, final, etc)'),
});

export interface FrontmatterProcessorOptions {
  model?: string;
  temperature?: number;
  overwriteExisting?: boolean;
  fieldsToExtract?: (keyof z.infer<typeof FrontmatterSchema>)[];
}

export class FrontmatterProcessor extends FileProcessor {
  readonly name = 'FrontmatterProcessor';
  
  constructor(private readonly opts: FrontmatterProcessorOptions = {}) {
    super();
  }

  protected async processFile(event: FileEvent): Promise<void> {
    if (event.type !== FileEventType.Changed && event.type !== FileEventType.Added) {
      return;
    }

    const ext = path.extname(event.path).toLowerCase();
    if (ext !== '.md' && ext !== '.mdx') {
      logger.debug(`Skipping non-markdown file: ${event.path}`);
      return;
    }

    try {
      const content = await readFile(event.path, 'utf-8');
      const parsed = parseFrontmatter(content);
      
      const existingFrontmatter = parsed.frontmatter;
      const hasExistingFrontmatter = Object.keys(existingFrontmatter).length > 0;
      
      if (hasExistingFrontmatter && !this.opts.overwriteExisting) {
        logger.debug(`Skipping file with existing frontmatter: ${event.path}`);
        return;
      }

      const extractedFrontmatter = await this.extractFrontmatter(parsed.body, existingFrontmatter);
      
      const mergedFrontmatter = this.opts.overwriteExisting 
        ? { ...existingFrontmatter, ...extractedFrontmatter }
        : { ...extractedFrontmatter, ...existingFrontmatter };

      const updatedContent = this.buildMarkdownWithFrontmatter(mergedFrontmatter, parsed.body);
      
      await writeFile(event.path, updatedContent, 'utf-8');
      logger.info(`Updated frontmatter for: ${event.path}`);
    } catch (error) {
      logger.error(`Failed to process frontmatter for ${event.path}:`, error);
      throw error;
    }
  }

  private async extractFrontmatter(
    content: string, 
    existing: FrontmatterData
  ): Promise<Partial<z.infer<typeof FrontmatterSchema>>> {
    const modelName = this.opts.model ?? 'gpt-4o-mini';
    
    const prompt = [
      'Extract metadata from the following markdown content.',
      'Focus on identifying key information that would be useful as frontmatter.',
      'Be concise and accurate.',
      existing && Object.keys(existing).length > 0 
        ? `Existing frontmatter: ${JSON.stringify(existing)}`
        : '',
      '---',
      content.slice(0, 3000),
    ].filter(Boolean).join('\n');

    try {
      const schema = this.opts.fieldsToExtract 
        ? z.object(
            Object.fromEntries(
              this.opts.fieldsToExtract.map(field => [
                field,
                FrontmatterSchema.shape[field]
              ])
            )
          )
        : FrontmatterSchema;

      const { object } = await generateObject({
        model: openai(modelName),
        temperature: this.opts.temperature ?? 0.3,
        maxTokens: 500,
        prompt,
        schema,
      });

      return object;
    } catch (error) {
      logger.error('Failed to extract frontmatter:', error);
      if (error instanceof Error) {
        logger.error('Error details:', error.message);
        logger.error('Stack:', error.stack);
      }
      return {};
    }
  }

  private buildMarkdownWithFrontmatter(
    frontmatter: FrontmatterData,
    body: string
  ): string {
    if (Object.keys(frontmatter).length === 0) {
      return body;
    }

    const yamlLines: string[] = ['---'];
    
    for (const [key, value] of Object.entries(frontmatter)) {
      if (value === undefined || value === null) continue;
      
      if (Array.isArray(value)) {
        if (value.length === 0) continue;
        yamlLines.push(`${key}:`);
        value.forEach(item => {
          yamlLines.push(`  - ${item}`);
        });
      } else if (typeof value === 'object') {
        yamlLines.push(`${key}: ${JSON.stringify(value)}`);
      } else {
        const stringValue = String(value);
        const needsQuotes = stringValue.includes(':') || 
                           stringValue.includes('#') || 
                           stringValue.includes('\n');
        yamlLines.push(`${key}: ${needsQuotes ? `"${stringValue.replace(/"/g, '\\"')}"` : stringValue}`);
      }
    }
    
    yamlLines.push('---', '');
    
    return yamlLines.join('\n') + body;
  }
}