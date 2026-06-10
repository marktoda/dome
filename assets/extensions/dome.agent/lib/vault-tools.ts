// Shared vault tool library for dome.agent agents. Each factory returns an
// AgentTool bound to an injected VaultReader (the test/snapshot seam). The
// read helpers overlay the in-run AgentRunState so successive edits compose.
//
// Write-capable tools take the processor's writable path globs (a bundle-
// local mirror of its manifest patch.auto grant, pinned by the
// grant-aware-tools manifest-sync test) and reject out-of-grant paths at
// tool time. The model sees the rejection as an ordinary tool error and can
// self-correct mid-loop; without this, the first out-of-grant path surfaces
// only after the run, when the broker downgrades the ENTIRE batched
// PatchEffect to patch.propose (the capability-downgrade-surprise gotcha).
// `globMatch` is the broker's own matcher, so tool-time and broker
// semantics cannot drift.

import { globMatch } from "../../../../src/engine/glob-cache";
import type { AgentRunState, AgentTool } from "./agent-loop";
import {
  isValidSignalsAppend,
  PREFERENCE_SIGNALS_PATH,
} from "./preferences-shared";

export type WritablePaths = ReadonlyArray<string>;

/** Rejection message for an out-of-grant write, or null when writable. */
export function writeDenial(
  path: string,
  writable: WritablePaths,
): string | null {
  if (writable.some((pattern) => globMatch(pattern, path))) return null;
  return `error: ${path} is outside this agent's writable paths (${writable.join(", ")}); pick a path matching one of those globs.`;
}

/**
 * A page-level write rule the write-capable tools consult AFTER the glob
 * grant check. Returns a denial message (surfaced to the model as an
 * ordinary tool error, self-correctable mid-loop) or null to allow.
 * `nextContent === null` means the tool wants to delete the page.
 */
export type PageWriteGuard = (input: {
  readonly path: string;
  readonly nextContent: string | null;
  readonly state: AgentRunState;
}) => Promise<string | null>;

/**
 * Run several page-level guards in order; the first denial wins. Lets a
 * tool seam stack independent page rules (e.g. the signals append-only
 * guard plus ingest's captured-tasks daily guard) behind the single
 * `PageWriteGuard` slot the write tools accept.
 */
export function composePageWriteGuards(
  ...guards: ReadonlyArray<PageWriteGuard>
): PageWriteGuard {
  return async (input) => {
    for (const guard of guards) {
      const denial = await guard(input);
      if (denial !== null) return denial;
    }
    return null;
  };
}

/**
 * The signals page is append-only at the tool seam: a write must keep the
 * existing content byte-for-byte and append well-formed signal lines, and
 * the page can never be deleted — otherwise a model could rewrite or drop
 * the owner's rejection tombstones (wiki/specs/preferences.md §"Signal
 * grammar"). Mirrors the brief processor's post-run splice guard so ingest
 * and consolidate enforce the same rule at tool time.
 */
export function signalsAppendOnlyGuard(reader: VaultReader): PageWriteGuard {
  return async ({ path, nextContent, state }) => {
    if (path !== PREFERENCE_SIGNALS_PATH) return null;
    if (nextContent === null) {
      return `error: ${PREFERENCE_SIGNALS_PATH} is append-only (the owner's preference history and rejection tombstones live here); it cannot be deleted.`;
    }
    const before = await currentContent(path, state, reader);
    // A byte-identical rewrite is a harmless no-op, not a violation.
    if (before !== null && nextContent === before) return null;
    if (!isValidSignalsAppend({ before, after: nextContent })) {
      return (
        `error: ${PREFERENCE_SIGNALS_PATH} is append-only; keep the existing ` +
        "content unchanged and append well-formed signal lines " +
        "(`- YYYY-MM-DD [+|-] <topic-slug>:: <rule text>`). Rewrites, " +
        "deletions, and prose are rejected."
      );
    }
    return null;
  };
}

export type VaultReader = {
  readonly readFile: (path: string) => Promise<string | null>;
  readonly listMarkdownFiles: () => Promise<ReadonlyArray<string>>;
};

const STRING = { type: "string" } as const;

export function objectSchema(
  props: Record<string, unknown>,
  required: ReadonlyArray<string>,
): Readonly<Record<string, unknown>> {
  return { type: "object", properties: props, required, additionalProperties: false };
}

// Cap a single read so one large page can't blow the context budget.
// Exported so callers that embed page content into a task turn (e.g. the
// sweep processor's pre-flight oversized-destination guard) can detect when
// a read WOULD be truncated and refuse to edit on partial context.
export const MAX_READ_CHARS = 20_000;
export function capRead(content: string): string {
  if (content.length <= MAX_READ_CHARS) return content;
  return `${content.slice(0, MAX_READ_CHARS)}\n…[truncated ${content.length - MAX_READ_CHARS} chars — read a more specific section if needed]`;
}

export async function currentContent(
  path: string,
  state: AgentRunState,
  reader: VaultReader,
): Promise<string | null> {
  const pending = state.edits.get(path);
  if (pending?.kind === "write") return pending.content;
  if (pending?.kind === "delete") return null;
  return reader.readFile(path);
}

// snapshot paths ∪ pages written this run − pages deleted this run.
export async function overlayPaths(
  state: AgentRunState,
  reader: VaultReader,
): Promise<ReadonlyArray<string>> {
  const set = new Set(await reader.listMarkdownFiles());
  for (const [path, edit] of state.edits) {
    if (edit.kind === "write") set.add(path);
    else set.delete(path);
  }
  return [...set].sort();
}

export function readPageTool(reader: VaultReader): AgentTool {
  return {
    schema: {
      name: "readPage",
      description: "Read a vault file's current content. Returns null if absent.",
      inputSchema: objectSchema({ path: STRING }, ["path"]),
    },
    execute: async (input, state) => {
      const { path } = input as { path: string };
      const content = await currentContent(path, state, reader);
      return content === null ? `(no file at ${path})` : capRead(content);
    },
  };
}

export function listPagesTool(reader: VaultReader): AgentTool {
  return {
    schema: {
      name: "listPages",
      description: "List all readable markdown paths in the vault.",
      inputSchema: objectSchema({}, []),
    },
    execute: async (_input, state) => (await overlayPaths(state, reader)).join("\n"),
  };
}

export function searchVaultTool(reader: VaultReader): AgentTool {
  return {
    schema: {
      name: "searchVault",
      description: "Find readable markdown paths whose content contains the query (case-insensitive).",
      inputSchema: objectSchema({ query: STRING }, ["query"]),
    },
    execute: async (input, state) => {
      const { query } = input as { query: string };
      const needle = query.toLowerCase();
      const hits: string[] = [];
      for (const path of await overlayPaths(state, reader)) {
        const content = await currentContent(path, state, reader);
        if (content !== null && content.toLowerCase().includes(needle)) hits.push(path);
        if (hits.length >= 25) break;
      }
      return hits.length === 0 ? "(no matches)" : hits.join("\n");
    },
  };
}

export function writePageTool(
  writable: WritablePaths,
  guard?: PageWriteGuard,
): AgentTool {
  return {
    schema: {
      name: "writePage",
      description: "Create or fully replace a file. Read first when updating.",
      inputSchema: objectSchema({ path: STRING, content: STRING }, ["path", "content"]),
    },
    execute: async (input, state) => {
      const { path, content } = input as { path: string; content: string };
      const denial = writeDenial(path, writable);
      if (denial !== null) return denial;
      const guardDenial = await guard?.({ path, nextContent: content, state });
      if (guardDenial !== undefined && guardDenial !== null) return guardDenial;
      state.edits.set(path, { kind: "write", path, content });
      return `wrote ${path}`;
    },
  };
}

export function appendToPageTool(
  reader: VaultReader,
  writable: WritablePaths,
  guard?: PageWriteGuard,
): AgentTool {
  return {
    schema: {
      name: "appendToPage",
      description: "Append a block to the end of a file (creates it if absent).",
      inputSchema: objectSchema({ path: STRING, content: STRING }, ["path", "content"]),
    },
    execute: async (input, state) => {
      const { path, content } = input as { path: string; content: string };
      const denial = writeDenial(path, writable);
      if (denial !== null) return denial;
      const existing = await currentContent(path, state, reader);
      const next =
        existing === null || existing.trim() === ""
          ? content
          : `${existing.replace(/\s+$/, "")}\n${content}`;
      const guardDenial = await guard?.({ path, nextContent: next, state });
      if (guardDenial !== undefined && guardDenial !== null) return guardDenial;
      state.edits.set(path, { kind: "write", path, content: next });
      return `appended to ${path}`;
    },
  };
}

export function archiveSourceTool(
  reader: VaultReader,
  writable: WritablePaths,
): AgentTool {
  return {
    schema: {
      name: "archiveSource",
      description: "Move a consumed inbox/raw source to inbox/processed.",
      inputSchema: objectSchema({ rawPath: STRING }, ["rawPath"]),
    },
    execute: async (input, state) => {
      const { rawPath } = input as { rawPath: string };
      // Outside inbox/raw/ the processed-path rewrite is a no-op and the
      // write+delete on the SAME key would net out to deleting the source.
      if (!rawPath.startsWith("inbox/raw/")) {
        return `error: archiveSource only archives inbox/raw/ sources; got ${rawPath}.`;
      }
      const processedPath = rawPath.replace(/^inbox\/raw\//, "inbox/processed/");
      const denial =
        writeDenial(processedPath, writable) ?? writeDenial(rawPath, writable);
      if (denial !== null) return denial;
      const body = (await currentContent(rawPath, state, reader)) ?? "";
      state.edits.set(processedPath, { kind: "write", path: processedPath, content: body });
      state.edits.set(rawPath, { kind: "delete", path: rawPath });
      return `archived ${rawPath} -> ${processedPath}`;
    },
  };
}

export function deletePageTool(
  writable: WritablePaths,
  guard?: PageWriteGuard,
): AgentTool {
  return {
    schema: {
      name: "deletePage",
      description: "Delete a vault file (used when merging its content into a canonical page). Rewrite inbound links first.",
      inputSchema: objectSchema({ path: STRING }, ["path"]),
    },
    execute: async (input, state) => {
      const { path } = input as { path: string };
      const denial = writeDenial(path, writable);
      if (denial !== null) return denial;
      const guardDenial = await guard?.({ path, nextContent: null, state });
      if (guardDenial !== undefined && guardDenial !== null) return guardDenial;
      state.edits.set(path, { kind: "delete", path });
      return `deleted ${path}`;
    },
  };
}

export function askOwnerTool(idempotencyPrefix: string): AgentTool {
  return {
    schema: {
      name: "askOwner",
      description: "Ask the owner a question when a decision is genuinely uncertain.",
      inputSchema: objectSchema({ question: STRING }, ["question"]),
    },
    execute: async (input, state) => {
      const { question } = input as { question: string };
      state.questions.push({ question, idempotencyKey: `${idempotencyPrefix}${question}` });
      return "asked the owner";
    },
  };
}
