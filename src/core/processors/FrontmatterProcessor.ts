/**
 * Simplified processor for extracting and updating frontmatter using AI.
 */

import { FileProcessor, FileEvent, FileEventType } from './FileProcessor.js';
import { frontmatterService } from '../services/ServiceContainer.js';
import { aiGenerateObject } from '../../mastra/services/AIService.js';
import { z } from 'zod';
import { readFile, writeFile } from 'node:fs/promises';
import logger from '../utils/logger.js';
import path from 'node:path';
import { config } from '../utils/config.js';

const FrontmatterSchema = z.object({
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
  summary: z.string().optional(),
  date: z.string().optional(),
  type: z.string().optional(),
  project: z.string().optional(),
});

export class FrontmatterProcessor extends FileProcessor {
  readonly name = 'FrontmatterProcessor';

  constructor(private readonly skipExisting = true) {
    super();
  }

  protected async processFile(event: FileEvent): Promise<void> {
    // Only process markdown files on change/add
    if (event.type !== FileEventType.Changed && event.type !== FileEventType.Added) return;
    if (!event.path.match(/\.mdx?$/i)) return;

    try {
      const content = await readFile(event.path, 'utf-8');
      const parsed = frontmatterService.parse(content);

      // Skip if has frontmatter and configured to skip
      if (this.skipExisting && Object.keys(parsed.data).length > 0) return;

      // Extract frontmatter using AI
      const prompt = `Extract metadata from this markdown:\n\n${parsed.content.slice(0, 2000)}`;
      const extracted = await aiGenerateObject(prompt, FrontmatterSchema, {
        model: config.ai.models.frontmatter,
        temperature: 0.3,
        maxTokens: 300,
      });

      // Skip if nothing extracted
      if (!extracted || Object.keys(extracted).length === 0) return;

      // Merge and update
      const merged = { ...extracted, ...parsed.data };
      const updated = frontmatterService.stringify(parsed.content, merged);

      await writeFile(event.path, updated, 'utf-8');
      logger.info(`[FrontmatterProcessor] Updated frontmatter: ${event.path}`);
    } catch (error) {
      logger.error(`Frontmatter processing failed for ${event.path}: ${error}`);
    }
  }
}
