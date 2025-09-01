/**
 * Simple note summarization service.
 */

import { aiSummarize } from '../../mastra/services/AIService.js';
import logger from '../utils/logger.js';

export interface SummarizationInput {
  path: string;
  title: string;
  content: string;
  frontmatter?: Record<string, unknown>;
}

export class NoteSummarizer {
  async summarize(input: SummarizationInput): Promise<string> {
    try {
      const content = `Title: ${input.title}\n${input.content}`;
      return await aiSummarize(content, 2);
    } catch (error) {
      logger.warn(`Failed to summarize ${input.path}: ${error}`);
      return 'Summary unavailable';
    }
  }
}