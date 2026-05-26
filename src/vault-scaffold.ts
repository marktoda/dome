// Shared vault-skeleton scaffolder. The single source of truth for "what does
// a fresh Dome vault look like on disk". Consumers:
//
//   - `dome init` creates a brand-new vault from nothing.
//   - `dome migrate` scaffolds .dome/ + index/log onto an EXISTING markdown
//     directory (e.g., an Obsidian vault) before the migrate workflow runs.
//   - eval/fixture-vault creates ephemeral test vaults.
//
// Each consumer decorates the skeleton with its own extras (init adds
// AGENTS.md + CLAUDE.md shim + intake-raw.yaml + initial commit; fixture
// writes test files; migrate leaves existing content untouched). Centralizing
// prevents drift — the three callers previously copy-pasted the directory
// tree + config strings and had already begun diverging.

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { shippedConfigYaml, shippedPageTypesYaml } from "./shipped-defaults";

/** `.gitignore` shipped by `dome init`. */
export const SHIPPED_GITIGNORE = `.dome/state/
node_modules/
.DS_Store
`;

/** Initial `index.md` body. */
const SHIPPED_INDEX_MD = `# Index\n\nThe catalog of wiki pages in this vault.\n`;

/** Build the first `log.md` entry; ISO timestamp varies per init call. */
function shippedLogMd(now: Date = new Date()): string {
  return `# Log\n\n## [${now.toISOString()}] bootstrap | initialize Dome vault\n`;
}

export interface ScaffoldOpts {
  /**
   * When true (default), write index.md and log.md if absent. False leaves
   * existing root files alone — used by `dome migrate` against an existing
   * markdown vault that may already have its own index/log conventions.
   */
  writeIndexAndLog?: boolean;
  /**
   * When true (default), write `.gitignore` if absent. False leaves an
   * existing .gitignore untouched.
   */
  writeGitignore?: boolean;
  /** Override config.yaml content (used by fixture-vault for test configs). */
  configOverride?: string;
  /** Override page-types.yaml content. */
  pageTypesOverride?: string;
}

/**
 * Create the canonical Dome vault directory tree under `vaultPath`. Idempotent
 * for the directory tree (mkdir recursive). Files are written only when they
 * do NOT already exist — so calling this on an existing vault won't overwrite
 * config or content.
 *
 * Returns the list of files written (relative paths). Callers can use it to
 * decide what to commit to git.
 */
export async function scaffoldVaultLayout(
  vaultPath: string,
  opts: ScaffoldOpts = {},
): Promise<string[]> {
  const writeIndexAndLog = opts.writeIndexAndLog ?? true;
  const writeGitignore = opts.writeGitignore ?? true;
  const config = opts.configOverride ?? shippedConfigYaml();
  const pageTypes = opts.pageTypesOverride ?? shippedPageTypesYaml();
  const written: string[] = [];

  // Directory tree (idempotent).
  await mkdir(vaultPath, { recursive: true });
  for (const rel of [
    ".dome/state",
    ".dome/prompts",
    ".dome/hooks",
    "wiki/entities",
    "wiki/concepts",
    "wiki/sources",
    "wiki/syntheses",
    "raw",
    "notes",
    "inbox/raw",
  ]) {
    await mkdir(join(vaultPath, rel), { recursive: true });
  }

  // Config files (write only if absent — migrate must not clobber an existing
  // vault that's already configured).
  if (await writeIfAbsent(vaultPath, ".dome/config.yaml", config)) {
    written.push(".dome/config.yaml");
  }
  if (await writeIfAbsent(vaultPath, ".dome/page-types.yaml", pageTypes)) {
    written.push(".dome/page-types.yaml");
  }

  if (writeGitignore && await writeIfAbsent(vaultPath, ".gitignore", SHIPPED_GITIGNORE)) {
    written.push(".gitignore");
  }

  if (writeIndexAndLog) {
    if (await writeIfAbsent(vaultPath, "index.md", SHIPPED_INDEX_MD)) {
      written.push("index.md");
    }
    if (await writeIfAbsent(vaultPath, "log.md", shippedLogMd())) {
      written.push("log.md");
    }
  }

  return written;
}

/** Write `relPath` under `vaultPath` only if it doesn't already exist. Returns true if the write happened. */
async function writeIfAbsent(vaultPath: string, relPath: string, contents: string): Promise<boolean> {
  const abs = join(vaultPath, relPath);
  if (existsSync(abs)) return false;
  await writeFile(abs, contents);
  return true;
}
