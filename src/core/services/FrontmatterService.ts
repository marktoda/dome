import matter from 'gray-matter';
import { z } from 'zod';
import logger from '../utils/logger.js';

export const FrontmatterSchema = z.object({
  title: z.string().optional(),
  date: z.string().optional(),
  tags: z.array(z.string()).optional(),
  participants: z.array(z.string()).optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  topics: z.array(z.string()).optional(),
  type: z.string().optional(),
  project: z.string().optional(),
  status: z.string().optional(),
  author: z.string().optional(),
  category: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  draft: z.boolean().optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
});

export type FrontmatterData = z.infer<typeof FrontmatterSchema> & {
  [key: string]: any;
};

export interface ParsedDocument {
  data: FrontmatterData;
  content: string;
  excerpt?: string;
  orig: string;
}

export interface FrontmatterOptions {
  excerpt?: boolean;
  excerpt_separator?: string;
  engines?: {
    [key: string]: (input: string) => any;
  };
  language?: string;
  delimiters?: string | [string, string];
}

export class FrontmatterService {
  private defaultOptions: FrontmatterOptions = {
    excerpt: true,
    excerpt_separator: '---',
  };

  constructor(private options: FrontmatterOptions = {}) {
    this.options = { ...this.defaultOptions, ...options };
  }

  /**
   * Parse markdown content with frontmatter
   */
  parse(content: string): ParsedDocument {
    try {
      const parsed = matter(content, this.options as any);
      
      return {
        data: this.normalizeData(parsed.data),
        content: parsed.content,
        excerpt: parsed.excerpt,
        orig: content,
      };
    } catch (error) {
      logger.error(`Failed to parse frontmatter: ${error}`);
      return {
        data: {},
        content: content,
        orig: content,
      };
    }
  }

  /**
   * Stringify document with frontmatter
   */
  stringify(content: string, data: FrontmatterData): string {
    try {
      const cleanData = this.cleanData(data);
      
      if (Object.keys(cleanData).length === 0) {
        return content;
      }

      return matter.stringify(content, cleanData, this.options as any);
    } catch (error) {
      logger.error(`Failed to stringify frontmatter: ${error}`);
      return content;
    }
  }

  /**
   * Update frontmatter in existing markdown content
   */
  update(content: string, updates: Partial<FrontmatterData>, overwrite = false): string {
    const parsed = this.parse(content);
    
    const newData = overwrite 
      ? { ...parsed.data, ...updates }
      : { ...updates, ...parsed.data };
    
    return this.stringify(parsed.content, newData);
  }

  /**
   * Extract frontmatter data only
   */
  extractData(content: string): FrontmatterData {
    const parsed = this.parse(content);
    return parsed.data;
  }

  /**
   * Extract content without frontmatter
   */
  extractContent(content: string): string {
    const parsed = this.parse(content);
    return parsed.content;
  }

  /**
   * Validate frontmatter data against schema
   */
  validate(data: any): { valid: boolean; errors?: z.ZodError } {
    try {
      FrontmatterSchema.parse(data);
      return { valid: true };
    } catch (error) {
      if (error instanceof z.ZodError) {
        return { valid: false, errors: error };
      }
      return { valid: false };
    }
  }

  /**
   * Merge multiple frontmatter objects
   */
  merge(...dataSets: Partial<FrontmatterData>[]): FrontmatterData {
    const merged = Object.assign({}, ...dataSets);
    return this.normalizeData(merged);
  }

  /**
   * Normalize frontmatter data
   */
  private normalizeData(data: any): FrontmatterData {
    const normalized: FrontmatterData = {};
    
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined || value === null || value === '') {
        continue;
      }
      
      // Normalize tags and similar array fields
      if (['tags', 'participants', 'topics', 'keywords'].includes(key)) {
        if (Array.isArray(value)) {
          normalized[key] = value.filter(Boolean).map(String);
        } else if (typeof value === 'string') {
          // Handle comma-separated strings
          normalized[key] = value.split(',').map(s => s.trim()).filter(Boolean);
        }
      } 
      // Normalize boolean fields
      else if (['draft', 'pinned', 'archived'].includes(key)) {
        normalized[key] = Boolean(value);
      }
      // Normalize date fields
      else if (key === 'date' && value) {
        // Ensure date is in ISO format if it's a Date object
        if (value instanceof Date) {
          normalized[key] = value.toISOString().split('T')[0];
        } else {
          normalized[key] = String(value);
        }
      }
      else {
        normalized[key] = value;
      }
    }
    
    return normalized;
  }

  /**
   * Clean data before stringifying (remove undefined/null values)
   */
  private cleanData(data: FrontmatterData): any {
    const cleaned: any = {};
    
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined && value !== null) {
        if (Array.isArray(value) && value.length === 0) {
          continue; // Skip empty arrays
        }
        cleaned[key] = value;
      }
    }
    
    return cleaned;
  }

  /**
   * Check if content has frontmatter
   */
  hasFrontmatter(content: string): boolean {
    return matter.test(content, this.options as any);
  }

  /**
   * Read frontmatter from a file path (utility method)
   */
  async readFile(filePath: string): Promise<ParsedDocument> {
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(filePath, 'utf-8');
    return this.parse(content);
  }

  /**
   * Write content with frontmatter to a file (utility method)
   */
  async writeFile(filePath: string, content: string, data: FrontmatterData): Promise<void> {
    const { writeFile } = await import('node:fs/promises');
    const output = this.stringify(content, data);
    await writeFile(filePath, output, 'utf-8');
  }
}

// Export a default instance for convenience
export const frontmatterService = new FrontmatterService();