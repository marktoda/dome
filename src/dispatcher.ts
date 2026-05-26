import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Effect, LogEntry, ToolError } from "./types";

// ----- Dispatcher-owned paths ----------------------------------------------
// Single source of truth for INDEX_AND_LOG_ARE_DISPATCHER_OWNED. The mutating
// Tools (writeDocument/moveDocument/deleteDocument) all consult this predicate
// rather than each duplicating the literal-string check.

export const DISPATCHER_OWNED_PATHS = ["index.md", "log.md"] as const;
export type DispatcherOwnedPath = typeof DISPATCHER_OWNED_PATHS[number];

export function isDispatcherOwned(path: string): path is DispatcherOwnedPath {
  return (DISPATCHER_OWNED_PATHS as readonly string[]).includes(path);
}

/**
 * Returns a `dispatcher-owned-path` ToolError when `path` is dispatcher-owned,
 * or `null` otherwise. Callers spread the returned object into their `err()`.
 */
export function refuseIfDispatcherOwned(
  path: string,
  toolName: string
): Extract<ToolError, { kind: "dispatcher-owned-path" }> | null {
  if (!isDispatcherOwned(path)) return null;
  return { kind: "dispatcher-owned-path", path, requested_tool: toolName };
}

export interface IndexEntry {
  path: string;
  title: string;
  blurb?: string;
}

export interface Dispatcher {
  writeIndex(entry: IndexEntry): Promise<Effect>;
  appendLogEntry(entry: LogEntry): Promise<Effect>;
}

export function makeDispatcher(vaultPath: string): Dispatcher {
  return {
    async writeIndex(entry: IndexEntry): Promise<Effect> {
      const indexPath = join(vaultPath, "index.md");
      const current = await safeRead(indexPath);
      const updated = mergeIndexEntry(current, entry);
      await writeFile(indexPath, updated);
      const diff = simpleDiff(current, updated, indexPath);
      return { kind: "wrote-document", path: "index.md", diff };
    },
    async appendLogEntry(entry: LogEntry): Promise<Effect> {
      const logPath = join(vaultPath, "log.md");
      const current = await safeRead(logPath);
      const line = formatLogEntry(entry);
      const updated = current.endsWith("\n") ? current + line : current + "\n" + line;
      await writeFile(logPath, updated);
      return { kind: "appended-log", entry };
    },
  };
}

async function safeRead(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function formatLogEntry(entry: LogEntry): string {
  const refs = entry.refs && entry.refs.length > 0 ? `\nrefs: ${entry.refs.join(", ")}` : "";
  const body = entry.body ? `\n\n${entry.body}` : "";
  return `## [${entry.ts}] ${entry.verb} | ${entry.subject}${refs}${body}\n`;
}

function mergeIndexEntry(current: string, entry: IndexEntry): string {
  const wikilink = `[[${entry.path.replace(/\.md$/, "")}]]`;
  if (current.includes(wikilink)) return current;
  const sectionMatch = entry.path.match(/^wiki\/(\w+)\//);
  const section = sectionMatch ? capitalize(sectionMatch[1]!) : "Other";
  const sectionHeader = `## ${section}`;
  const line = `- ${wikilink}${entry.blurb ?? ""}`;
  if (current.includes(sectionHeader)) {
    return current.replace(sectionHeader, `${sectionHeader}\n${line}`);
  }
  const sep = current.endsWith("\n") ? "" : "\n";
  return `${current}${sep}\n${sectionHeader}\n\n${line}\n`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function simpleDiff(_before: string, _after: string, path: string): string {
  return `--- a/${path}\n+++ b/${path}\n[content updated]`;
}
