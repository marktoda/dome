import { FileProcessor, FileEvent, FileEventType } from './FileProcessor.js';
import { FrontmatterService, FrontmatterData, FrontmatterSchema } from '../services/FrontmatterService.js';
import { openai } from '@ai-sdk/openai';
import { generateObject } from 'ai';
import { z } from 'zod';
import { readFile, writeFile } from 'node:fs/promises';
import logger from '../utils/logger.js';
import path from 'node:path';

// Extended schema for AI extraction with descriptions
const ExtractSchema = z.object({
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
  fieldsToExtract?: (keyof z.infer<typeof ExtractSchema>)[];
}

export class FrontmatterProcessor extends FileProcessor {
  readonly name = 'FrontmatterProcessor';
  private frontmatterService: FrontmatterService;
  
  constructor(private readonly opts: FrontmatterProcessorOptions = {}) {
    super();
    this.frontmatterService = new FrontmatterService();
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
      const parsed = this.frontmatterService.parse(content);
      
      const existingFrontmatter = parsed.data;
      const hasExistingFrontmatter = Object.keys(existingFrontmatter).length > 0;
      
      if (hasExistingFrontmatter && !this.opts.overwriteExisting) {
        logger.debug(`Skipping file with existing frontmatter: ${event.path}`);
        return;
      }

      const extractedFrontmatter = await this.extractFrontmatter(parsed.content, existingFrontmatter);
      
      const mergedFrontmatter = this.opts.overwriteExisting 
        ? { ...existingFrontmatter, ...extractedFrontmatter }
        : { ...extractedFrontmatter, ...existingFrontmatter };

      const updatedContent = this.frontmatterService.stringify(parsed.content, mergedFrontmatter);
      
      await writeFile(event.path, updatedContent, 'utf-8');
      logger.info(`Updated frontmatter for: ${event.path}`);
    } catch (error) {
      logger.error(`Failed to process frontmatter for ${event.path}: ${error}`);
      throw error;
    }
  }

  private async extractFrontmatter(
    content: string, 
    existing: FrontmatterData
  ): Promise<Partial<z.infer<typeof ExtractSchema>>> {
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
                ExtractSchema.shape[field]
              ])
            )
          )
        : ExtractSchema;

      const { object } = await generateObject({
        model: openai(modelName),
        temperature: this.opts.temperature ?? 0.3,
        maxTokens: 500,
        prompt,
        schema,
      });

      return object;
    } catch (error) {
      logger.error(`Failed to extract frontmatter: ${error}`);
      if (error instanceof Error) {
        logger.error(`Error details: ${error.message}`);
        logger.error(`Stack: ${error.stack}`);
      }
      return {};
    }
  }
}