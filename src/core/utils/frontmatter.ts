export interface FrontmatterData {
  title?: string;
  date?: string;
  tags?: string[];
  [key: string]: any;
}

export interface ParsedDocument {
  frontmatter: FrontmatterData;
  body: string;
}

/**
 * Parse frontmatter from markdown content
 * Supports YAML frontmatter delimited by ---
 */
export function parseFrontmatter(content: string): ParsedDocument {
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return {
      frontmatter: {},
      body: content,
    };
  }

  const frontmatterText = match[1];
  const body = content.slice(match[0].length);

  // Parse YAML frontmatter manually (simple parsing)
  const frontmatter: FrontmatterData = {};
  const lines = frontmatterText.split('\n');

  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();

    if (!key) continue;

    // Handle arrays (tags)
    if (key === 'tags') {
      if (value.startsWith('[') && value.endsWith(']')) {
        // Inline array format: [tag1, tag2]
        frontmatter.tags = value
          .slice(1, -1)
          .split(',')
          .map(t => t.trim())
          .filter(Boolean);
      } else {
        // Single tag
        frontmatter.tags = [value];
      }
    } else {
      // Remove quotes if present
      const cleanValue = value.replace(/^["']|["']$/g, '');
      frontmatter[key] = cleanValue;
    }
  }

  return {
    frontmatter,
    body,
  };
}
