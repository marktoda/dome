// Single source of Zod schemas for the SDK Tool surface, plus the
// exactOptionalPropertyTypes compaction helpers that strip undefined keys.
//
// Both the MCP adapter layer (src/mcp/tool-adapters.ts) and the AI SDK tool
// catalog (src/workflows/agent-loop.ts) consume these schemas; keeping them
// in one place eliminates a documented drift hazard.

import { z } from "zod";
import type { CreationReason, LogVerb } from "../types";
import type { WriteDocumentInput, WriteDocumentOpts } from "./write-document";
import type { AppendLogInput } from "./append-log";
import type { SearchIndexInput } from "./search-index";
import type { MoveDocumentInput } from "./move-document";
import type { DeleteDocumentInput } from "./delete-document";

export const readDocumentInput = z.object({ path: z.string() });

export const writeDocumentInput = z.object({
  path: z.string(),
  body: z.string(),
  frontmatter: z.record(z.string(), z.unknown()),
  opts: z
    .object({
      create: z.boolean().optional(),
      reason: z.enum(["recurring", "named_explicitly", "structural"]).optional(),
    })
    .optional(),
  // Optional ISO-8601 mtime snapshot from a prior readDocument; when set, the
  // Tool re-checks the file's mtime before writing and refuses on mismatch.
  // See docs/wiki/specs/sdk-surface.md §Concurrency.
  expected_mtime: z.string().optional(),
});

export const appendLogInput = z.object({
  verb: z.string(),
  subject: z.string(),
  body: z.string().optional(),
  refs: z.array(z.string()).optional(),
});

export const searchIndexInput = z.object({
  query: z.string(),
  filters: z
    .object({
      category: z.string().optional(),
      type: z.string().optional(),
      tags: z.array(z.string()).optional(),
    })
    .optional(),
});

export const wikilinkResolveInput = z.object({ link: z.string() });

export const moveDocumentInput = z.object({
  from: z.string(),
  to: z.string(),
  reason: z.string(),
  expected_mtime: z.string().optional(),
});

export const deleteDocumentInput = z.object({
  path: z.string(),
  reason: z.string(),
  expected_mtime: z.string().optional(),
});

// ----- Compaction helpers --------------------------------------------------
// Zod-parsed objects include `undefined` keys for unset optional fields, which
// violates exactOptionalPropertyTypes on the downstream Tool input interfaces.
// These helpers strip those keys.

export function compactWriteDocumentInput(parsed: z.infer<typeof writeDocumentInput>): WriteDocumentInput {
  const out: WriteDocumentInput = {
    path: parsed.path,
    body: parsed.body,
    frontmatter: parsed.frontmatter,
  };
  if (parsed.opts) {
    const opts: WriteDocumentOpts = {};
    if (parsed.opts.create !== undefined) opts.create = parsed.opts.create;
    if (parsed.opts.reason !== undefined) opts.reason = parsed.opts.reason as CreationReason;
    out.opts = opts;
  }
  if (parsed.expected_mtime !== undefined) out.expected_mtime = parsed.expected_mtime;
  return out;
}

export function compactAppendLogInput(parsed: z.infer<typeof appendLogInput>): AppendLogInput {
  const out: AppendLogInput = { verb: parsed.verb as LogVerb, subject: parsed.subject };
  if (parsed.body !== undefined) out.body = parsed.body;
  if (parsed.refs !== undefined) out.refs = parsed.refs;
  return out;
}

export function compactSearchIndexInput(parsed: z.infer<typeof searchIndexInput>): SearchIndexInput {
  const out: SearchIndexInput = { query: parsed.query };
  if (parsed.filters) {
    const filters: { category?: string; type?: string; tags?: string[] } = {};
    if (parsed.filters.category !== undefined) filters.category = parsed.filters.category;
    if (parsed.filters.type !== undefined) filters.type = parsed.filters.type;
    if (parsed.filters.tags !== undefined) filters.tags = parsed.filters.tags;
    out.filters = filters;
  }
  return out;
}

export function compactMoveDocumentInput(parsed: z.infer<typeof moveDocumentInput>): MoveDocumentInput {
  const out: MoveDocumentInput = { from: parsed.from, to: parsed.to, reason: parsed.reason };
  if (parsed.expected_mtime !== undefined) out.expected_mtime = parsed.expected_mtime;
  return out;
}

export function compactDeleteDocumentInput(parsed: z.infer<typeof deleteDocumentInput>): DeleteDocumentInput {
  const out: DeleteDocumentInput = { path: parsed.path, reason: parsed.reason };
  if (parsed.expected_mtime !== undefined) out.expected_mtime = parsed.expected_mtime;
  return out;
}
