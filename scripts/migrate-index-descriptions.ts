#!/usr/bin/env bun
// One-shot migration: parse `- [[path]] — description` entries from a
// vault's hand-written index.md and write each description into the target
// page's frontmatter, but only when the page lacks one. Non-entry lines
// (section headings, prose, blanks) are skipped silently. No git operations
// — the operator reviews the diff and commits (`git add -p` friendly).
//
// Frontmatter is never re-serialized: gray-matter is used only to READ
// (detect an existing description). The new `description:` line is spliced
// textually before the closing `---`, so every other byte of the file —
// bare YAML dates, quoting style, line wrapping — is preserved exactly.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import matter from "gray-matter";

export type MigrateOptions = {
  readonly dryRun: boolean;
};

export type MigrationSummary = {
  /** Relative paths whose frontmatter gained a description. */
  readonly updated: string[];
  /** Relative paths that already carried a description. */
  readonly skipped: string[];
  /** Relative paths referenced by index.md but missing on disk. */
  readonly unmatched: string[];
};

const ENTRY_PATTERN = /^- \[\[([^\]]+)\]\] — (.+)$/;

export function migrateIndexDescriptions(
  dir: string,
  options: MigrateOptions,
): MigrationSummary {
  const vault = resolve(dir);
  const indexPath = join(vault, "index.md");
  const indexSource = readFileSync(indexPath, "utf8");

  const updated: string[] = [];
  const skipped: string[] = [];
  const unmatched: string[] = [];
  /** Targets already claimed by an earlier entry → the description applied. */
  const seen = new Map<string, string>();

  for (const line of indexSource.split("\n")) {
    const entry = ENTRY_PATTERN.exec(line);
    if (entry === null) continue;

    const target = entry[1] ?? "";
    const description = (entry[2] ?? "").trim();
    if (target === "" || description === "") continue;

    // Wikilink targets may carry an alias (`path|alias`) and usually lack
    // the .md extension — resolve to the on-disk page path.
    const linkPath = (target.split("|")[0] ?? "").trim();
    const relativePath = linkPath.endsWith(".md") ? linkPath : `${linkPath}.md`;
    const pagePath = resolve(vault, relativePath);

    // Containment: an entry that resolves outside the vault (`../…`) never
    // touches disk — it needs operator eyes.
    if (!pagePath.startsWith(vault + sep)) {
      unmatched.push(relativePath);
      continue;
    }

    if (!existsSync(pagePath)) {
      unmatched.push(relativePath);
      continue;
    }

    // Duplicate entries for an already-updated target: the first wins.
    // Checked before re-reading the file so dry-run and real run report
    // identically. A repeat with a DIFFERING description is flagged
    // unmatched rather than silently skipped.
    const prior = seen.get(relativePath);
    if (prior !== undefined) {
      (prior === description ? skipped : unmatched).push(relativePath);
      continue;
    }

    const source = readFileSync(pagePath, "utf8");
    if (hasDescription(matter(source).data)) {
      skipped.push(relativePath);
      continue;
    }

    seen.set(relativePath, description);
    if (!options.dryRun) {
      writeFileSync(pagePath, insertDescription(source, description));
    }
    updated.push(relativePath);
  }

  return { updated, skipped, unmatched };
}

/** Existing frontmatter block at the very start of a file. */
const FRONTMATTER_BLOCK = /^---\n[\s\S]*?\n---/;

/**
 * Splice a single `description:` line immediately before the closing `---`
 * of the existing frontmatter block, or open a minimal new block when the
 * file has none. Every other byte of the file is preserved exactly.
 */
function insertDescription(source: string, description: string): string {
  const line = `description: ${yamlScalar(description)}\n`;
  const block = FRONTMATTER_BLOCK.exec(source)?.[0];
  if (block === undefined) return `---\n${line}---\n${source}`;
  const closingFence = block.length - 3;
  return source.slice(0, closingFence) + line + source.slice(closingFence);
}

/**
 * Render a YAML scalar without a serializer round-trip: plain when safe,
 * single-quoted (internal quotes doubled) when the value could change
 * meaning — `: `, `#`, edge whitespace, a trailing colon, or a leading
 * YAML indicator character.
 */
function yamlScalar(value: string): string {
  const risky =
    value.includes(": ") ||
    value.includes("#") ||
    value.trim() !== value ||
    value.endsWith(":") ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(value);
  return risky ? `'${value.replaceAll("'", "''")}'` : value;
}

function hasDescription(data: Record<string, unknown>): boolean {
  const value = data["description"];
  if (typeof value === "string") return value.trim() !== "";
  return value !== undefined && value !== null;
}

function main(): void {
  const args = Bun.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const dir = positional[0];

  if (dir === undefined || positional.length !== 1) {
    console.error(
      "Usage: bun scripts/migrate-index-descriptions.ts <vault-dir> [--dry-run]",
    );
    process.exit(1);
  }

  const summary = migrateIndexDescriptions(dir, { dryRun });
  const lines = [
    `updated: ${summary.updated.length}`,
    ...summary.updated.map((path) => `  + ${path}`),
    `skipped: ${summary.skipped.length}`,
    ...summary.skipped.map((path) => `  = ${path}`),
    `unmatched: ${summary.unmatched.length}`,
    ...summary.unmatched.map((path) => `  ? ${path}`),
  ];
  if (dryRun) lines.push("dry run — no files were written");
  process.stdout.write(`${lines.join("\n")}\n`);
}

if (import.meta.main) {
  main();
}
