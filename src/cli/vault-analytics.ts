// cli/vault-analytics: cheap first-glance facts for human CLI dashboards.
//
// This module is intentionally CLI-scoped rather than SDK-core. It reads the
// local working tree and vault directories directly to answer "what is in this
// vault right now?" without invoking processors or touching the adoption loop.

import { readdir, readFile, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";

import { statusMatrix } from "../git";

export type VaultAnalytics = {
  readonly dirty_modified: number;
  readonly dirty_untracked: number;
  readonly content_pages: number;
  readonly wiki_pages: number;
  readonly notes_pages: number;
  readonly inbox_pages: number;
  readonly inbox_raw_pages: number;
  readonly wikilinks: number;
  readonly raw_files: number;
  readonly raw_bytes: number;
};

type MarkdownTreeStats = {
  readonly files: number;
  readonly wikilinks: number;
};

type FileTreeStats = {
  readonly files: number;
  readonly bytes: number;
};

export async function collectVaultAnalytics(
  vaultPath: string,
): Promise<VaultAnalytics> {
  const [dirty, wiki, notes, inbox, inboxRaw, raw] = await Promise.all([
    collectDirtyStats(vaultPath),
    collectMarkdownTreeStats(join(vaultPath, "wiki")),
    collectMarkdownTreeStats(join(vaultPath, "notes")),
    collectMarkdownTreeStats(join(vaultPath, "inbox")),
    collectMarkdownTreeStats(join(vaultPath, "inbox", "raw"), {
      recursive: false,
    }),
    collectFileTreeStats(join(vaultPath, "raw")),
  ]);

  return {
    dirty_modified: dirty.dirty_modified,
    dirty_untracked: dirty.dirty_untracked,
    content_pages: wiki.files + notes.files + inbox.files,
    wiki_pages: wiki.files,
    notes_pages: notes.files,
    inbox_pages: inbox.files,
    inbox_raw_pages: inboxRaw.files,
    wikilinks: wiki.wikilinks + notes.wikilinks + inbox.wikilinks,
    raw_files: raw.files,
    raw_bytes: raw.bytes,
  };
}

async function collectDirtyStats(
  vaultPath: string,
): Promise<Pick<VaultAnalytics, "dirty_modified" | "dirty_untracked">> {
  const matrix = await statusMatrix(vaultPath);
  let dirty_modified = 0;
  let dirty_untracked = 0;

  for (const [filepath, head, workdir, stage] of matrix) {
    if (filepath === ".dome/state" || filepath.startsWith(".dome/state/")) {
      continue;
    }
    if (head === 0 && (workdir !== 0 || stage !== 0)) {
      dirty_untracked++;
    } else if (head !== workdir || head !== stage) {
      dirty_modified++;
    }
  }

  return { dirty_modified, dirty_untracked };
}

async function collectMarkdownTreeStats(
  dir: string,
  opts: { readonly recursive?: boolean } = {},
): Promise<MarkdownTreeStats> {
  const entries = await readDirIfPresent(dir);
  if (entries === null) return { files: 0, wikilinks: 0 };
  const recursive = opts.recursive !== false;

  let files = 0;
  let wikilinks = 0;
  for (const entry of entries) {
    const child = join(dir, entry.name);
    if (entry.isDirectory() && recursive) {
      const nested = await collectMarkdownTreeStats(child, opts);
      files += nested.files;
      wikilinks += nested.wikilinks;
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files++;
      wikilinks += countWikilinks(await readFile(child, "utf8"));
    }
  }

  return { files, wikilinks };
}

async function collectFileTreeStats(dir: string): Promise<FileTreeStats> {
  const entries = await readDirIfPresent(dir);
  if (entries === null) return { files: 0, bytes: 0 };

  let files = 0;
  let bytes = 0;
  for (const entry of entries) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectFileTreeStats(child);
      files += nested.files;
      bytes += nested.bytes;
    } else if (entry.isFile()) {
      const s = await stat(child);
      files++;
      bytes += s.size;
    }
  }

  return { files, bytes };
}

async function readDirIfPresent(dir: string): Promise<Dirent[] | null> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function countWikilinks(body: string): number {
  return body.match(/\[\[[^\]\n]+?\]\]/g)?.length ?? 0;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
