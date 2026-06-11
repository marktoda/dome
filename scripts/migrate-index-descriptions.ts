#!/usr/bin/env bun
// One-shot migration: parse `- [[path]] — description` entries from a
// vault's hand-written index.md and write each description into the target
// page's frontmatter, but only when the page lacks one. Non-entry lines
// (section headings, prose, blanks) are skipped silently. No git operations
// — the operator reviews the diff and commits (`git add -p` friendly).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
    const pagePath = join(vault, relativePath);

    if (!existsSync(pagePath)) {
      unmatched.push(relativePath);
      continue;
    }

    const source = readFileSync(pagePath, "utf8");
    const page = matter(source);
    if (hasDescription(page.data)) {
      skipped.push(relativePath);
      continue;
    }

    if (!options.dryRun) {
      // Re-serialize only the frontmatter block (gray-matter round-trip),
      // then append the original body bytes unchanged. Pages without any
      // frontmatter gain a new block holding just `description:` —
      // normalize-frontmatter canonicalizes key order on next adoption.
      // (stringify pads the empty body with an extra newline — trim the
      // block back to end exactly at the closing `---\n`.)
      const block = matter
        .stringify("", { ...page.data, description })
        .replace(/\n+$/, "\n");
      writeFileSync(pagePath, block + page.content);
    }
    updated.push(relativePath);
  }

  return { updated, skipped, unmatched };
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
