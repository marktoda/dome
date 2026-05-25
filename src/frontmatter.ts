import matter from "gray-matter";

export interface ParsedDocument {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parseFrontmatter(text: string): ParsedDocument {
  const result = matter(text);
  return {
    frontmatter: result.data as Record<string, unknown>,
    body: result.content,
  };
}

export function stringifyFrontmatter(frontmatter: Record<string, unknown>, body: string): string {
  return matter.stringify(body, frontmatter);
}
