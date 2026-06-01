// Shared path policy for dome.markdown processors.

export type FrontmatterLintMode = "required" | "optional" | "ignored";

const RESERVED_ROOT_MARKDOWN = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "index.md",
  "log.md",
]);

export function frontmatterLintModeForPath(path: string): FrontmatterLintMode {
  if (!path.endsWith(".md")) return "ignored";
  if (RESERVED_ROOT_MARKDOWN.has(path)) return "ignored";
  if (path.startsWith("templates/")) return "ignored";
  if (path.startsWith("raw/assets/")) return "ignored";
  if (path.startsWith("wiki/")) return "required";
  if (path.startsWith("notes/")) return "optional";
  if (path.startsWith("raw/")) return "optional";
  if (path.startsWith("inbox/")) return "optional";
  return "ignored";
}

