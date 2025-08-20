import { FileProcessor, FileEvent, FileEventType } from './FileProcessor.js';
import { openai } from '@ai-sdk/openai';
import { generateObject } from 'ai';
import fs from 'node:fs/promises';
import path from 'node:path';
import logger from '../utils/logger.js';
import { z } from 'zod';
import matter from 'gray-matter';
import { getWatcherConfig } from '../../watcher/config.js';

const FileIndexSchema = z.object({
  summary: z.string().describe('A brief 1-2 sentence summary of the file content'),
  keywords: z.array(z.string()).describe('5-10 relevant keywords or tags for searching'),
  topics: z.array(z.string()).describe('Main topics or themes covered in the file'),
});

type FileIndexEntry = z.infer<typeof FileIndexSchema> & {
  path: string;
  lastModified: string;
  title?: string;
};

interface FolderIndex {
  version: string;
  lastUpdated: string;
  files: Record<string, FileIndexEntry>;
}

export class IndexProcessor extends FileProcessor {
  readonly name = 'IndexGenerator';
  private indexCache = new Map<string, FolderIndex>();

  protected async processFile(event: FileEvent): Promise<void> {
    const { type, path: filePath, relativePath } = event;

    // Skip non-markdown files
    if (!relativePath.endsWith('.md')) {
      return;
    }

    // Get folder path
    const folderPath = path.dirname(filePath);

    if (type === FileEventType.Deleted) {
      await this.removeFromIndex(folderPath, relativePath);
      logger.info(`[IndexProcessor] Removed ${relativePath} from index`);
    } else {
      await this.updateIndex(folderPath, filePath, relativePath);
      logger.info(`[IndexProcessor] Updated index for ${relativePath}`);
    }
  }

  private async updateIndex(folderPath: string, filePath: string, relativePath: string): Promise<void> {
    try {
      // Read the file content
      const content = await fs.readFile(filePath, 'utf-8');

      // Parse frontmatter if present
      const { data: frontmatter, content: bodyContent } = matter(content);

      // Skip if file is too short
      if (bodyContent.trim().length < 50) {
        logger.debug(`[IndexProcessor] Skipping ${relativePath} - content too short`);
        return;
      }

      // Generate summary and keywords using LLM
      logger.debug(`[IndexProcessor] Generating summary for ${relativePath}`);

      const analysis = await this.analyzeContent(bodyContent, frontmatter);

      // Load or create index for this folder
      const index = await this.loadOrCreateIndex(folderPath);

      // Update the index entry
      index.files[relativePath] = {
        path: relativePath,
        title: frontmatter.title || path.basename(relativePath, '.md'),
        summary: analysis.summary,
        keywords: analysis.keywords,
        topics: analysis.topics,
        lastModified: new Date().toISOString(),
      };

      index.lastUpdated = new Date().toISOString();

      // Save the updated index
      await this.saveIndex(folderPath, index);

    } catch (error) {
      logger.error(`[IndexProcessor] Failed to update index for ${relativePath}:`, error);
      throw error;
    }
  }

  private async removeFromIndex(folderPath: string, relativePath: string): Promise<void> {
    try {
      const index = await this.loadOrCreateIndex(folderPath);

      if (index.files[relativePath]) {
        delete index.files[relativePath];
        index.lastUpdated = new Date().toISOString();
        await this.saveIndex(folderPath, index);
      }
    } catch (error) {
      logger.error(`[IndexProcessor] Failed to remove ${relativePath} from index:`, error);
    }
  }

  private async analyzeContent(
    content: string,
    frontmatter: Record<string, any>
  ): Promise<z.infer<typeof FileIndexSchema>> {
    try {
      // Truncate content if too long (to manage token usage)
      const maxLength = 4000;
      const truncatedContent = content.length > maxLength
        ? content.substring(0, maxLength) + '...'
        : content;

      const prompt = `Analyze the following markdown document and provide a summary, keywords, and main topics.

Frontmatter:
${JSON.stringify(frontmatter, null, 2)}

Content:
${truncatedContent}

Focus on:
1. The main purpose and key points of the document
2. Relevant searchable keywords (technical terms, concepts, names)
3. High-level topics or themes covered`;

      const { object } = await generateObject({
        model: openai('gpt-4o-mini'),
        schema: FileIndexSchema,
        prompt,
      });

      return object;
    } catch (error) {
      logger.error('[IndexProcessor] LLM analysis failed:', error);

      // Fallback to basic extraction
      return {
        summary: 'Document analysis pending',
        keywords: this.extractBasicKeywords(content),
        topics: [],
      };
    }
  }

  private extractBasicKeywords(content: string): string[] {
    // Basic keyword extraction as fallback
    const words = content
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 4);

    // Count word frequency
    const wordFreq = new Map<string, number>();
    words.forEach(word => {
      wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
    });

    // Get top 10 most frequent words
    return Array.from(wordFreq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word]) => word);
  }

  private async loadOrCreateIndex(folderPath: string): Promise<FolderIndex> {
    // Check cache first
    const cached = this.indexCache.get(folderPath);
    if (cached) {
      return cached;
    }

    const indexPath = path.join(folderPath, '.index.json');

    try {
      const data = await fs.readFile(indexPath, 'utf-8');
      const index = JSON.parse(data) as FolderIndex;

      // Validate version
      if (index.version !== '1.0.0') {
        throw new Error(`Unsupported index version: ${index.version}`);
      }

      this.indexCache.set(folderPath, index);
      return index;
    } catch (error) {
      // Create new index if it doesn't exist or is invalid
      const newIndex: FolderIndex = {
        version: '1.0.0',
        lastUpdated: new Date().toISOString(),
        files: {},
      };

      this.indexCache.set(folderPath, newIndex);
      return newIndex;
    }
  }

  private async saveIndex(folderPath: string, index: FolderIndex): Promise<void> {
    const indexPath = path.join(folderPath, '.index.json');

    // Update cache
    this.indexCache.set(folderPath, index);

    // Write to disk with pretty formatting
    await fs.writeFile(
      indexPath,
      JSON.stringify(index, null, 2),
      'utf-8'
    );

    // Also create a human-readable markdown index
    await this.createMarkdownIndex(folderPath, index);
  }

  private async createMarkdownIndex(folderPath: string, index: FolderIndex): Promise<void> {
    const indexMdPath = path.join(folderPath, 'INDEX.md');

    let markdown = `# Folder Index

*Last updated: ${new Date(index.lastUpdated).toLocaleString()}*

## Files

`;

    // Sort files by path
    const sortedFiles = Object.values(index.files).sort((a, b) =>
      a.path.localeCompare(b.path)
    );

    for (const file of sortedFiles) {
      markdown += `### ${file.title || path.basename(file.path)}\n`;
      markdown += `**Path:** \`${file.path}\`\n\n`;
      markdown += `**Summary:** ${file.summary}\n\n`;

      if (file.topics.length > 0) {
        markdown += `**Topics:** ${file.topics.join(', ')}\n\n`;
      }

      if (file.keywords.length > 0) {
        markdown += `**Keywords:** ${file.keywords.map(k => `\`${k}\``).join(', ')}\n\n`;
      }

      markdown += `---\n\n`;
    }

    await fs.writeFile(indexMdPath, markdown, 'utf-8');
  }
}
