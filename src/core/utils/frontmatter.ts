import { frontmatterService, type FrontmatterData } from '../services/FrontmatterService.js';

// Re-export types for backward compatibility
export type { FrontmatterData } from '../services/FrontmatterService.js';

export interface ParsedDocument {
  frontmatter: FrontmatterData;
  body: string;
}

/**
 * Parse frontmatter from markdown content
 * Supports YAML frontmatter delimited by ---
 * @deprecated Use FrontmatterService.parse() instead
 */
export function parseFrontmatter(content: string): ParsedDocument {
  const parsed = frontmatterService.parse(content);
  return {
    frontmatter: parsed.data,
    body: parsed.content,
  };
}
