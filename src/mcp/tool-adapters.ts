import { z } from "zod";
import type { Vault } from "../vault";
import { McpToolName } from "./tool-names";
import type { Effect, ToolReturn, Sensitivity, CreationReason, LogVerb } from "../types";
import type { WriteDocumentInput, WriteDocumentOpts } from "../tools/write-document";
import type { AppendLogInput } from "../tools/append-log";
import type { SearchIndexInput } from "../tools/search-index";

export interface ToolAdapterResult {
  ok: boolean;
  data?: unknown;
  error?: unknown;
  effects: ReadonlyArray<Effect>;
}

export interface ToolAdapter {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  handler: (input: unknown) => Promise<ToolAdapterResult>;
}

const readDocumentInput = z.object({ path: z.string() });
const writeDocumentInput = z.object({
  path: z.string(),
  body: z.string(),
  frontmatter: z.record(z.string(), z.unknown()),
  opts: z.object({
    create: z.boolean().optional(),
    reason: z.enum(["recurring", "named_explicitly", "structural"]).optional(),
    sensitivity_classified: z.enum(["normal", "sensitive"]).optional(),
  }).optional(),
});
const appendLogInput = z.object({
  verb: z.string(),
  subject: z.string(),
  body: z.string().optional(),
  refs: z.array(z.string()).optional(),
});
const searchIndexInput = z.object({
  query: z.string(),
  filters: z.object({
    category: z.string().optional(),
    type: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }).optional(),
});
const wikilinkResolveInput = z.object({ link: z.string() });
const moveDocumentInput = z.object({ from: z.string(), to: z.string(), reason: z.string() });
const deleteDocumentInput = z.object({ path: z.string(), reason: z.string() });

async function wrap<T>(invoker: () => Promise<ToolReturn<T>>): Promise<ToolAdapterResult> {
  const out = await invoker();
  if (out.result.ok) {
    return { ok: true, data: out.result.value, effects: out.effects };
  }
  return { ok: false, error: out.result.error, effects: out.effects };
}

// Strip undefined fields so the parsed object satisfies exactOptionalPropertyTypes downstream.
function compactWriteDocumentInput(parsed: z.infer<typeof writeDocumentInput>): WriteDocumentInput {
  const out: WriteDocumentInput = {
    path: parsed.path,
    body: parsed.body,
    frontmatter: parsed.frontmatter,
  };
  if (parsed.opts) {
    const opts: WriteDocumentOpts = {};
    if (parsed.opts.create !== undefined) opts.create = parsed.opts.create;
    if (parsed.opts.reason !== undefined) opts.reason = parsed.opts.reason as CreationReason;
    if (parsed.opts.sensitivity_classified !== undefined) {
      opts.sensitivity_classified = parsed.opts.sensitivity_classified as Sensitivity;
    }
    out.opts = opts;
  }
  return out;
}

function compactAppendLogInput(parsed: z.infer<typeof appendLogInput>): AppendLogInput {
  const out: AppendLogInput = { verb: parsed.verb as LogVerb, subject: parsed.subject };
  if (parsed.body !== undefined) out.body = parsed.body;
  if (parsed.refs !== undefined) out.refs = parsed.refs;
  return out;
}

function compactSearchIndexInput(parsed: z.infer<typeof searchIndexInput>): SearchIndexInput {
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

export function buildToolAdapters(vault: Vault): ToolAdapter[] {
  return [
    {
      name: McpToolName.ReadDocument,
      description: "Read a Document by path.",
      inputSchema: readDocumentInput,
      handler: async (input) => wrap(() => vault.tools.readDocument(readDocumentInput.parse(input))),
    },
    {
      name: McpToolName.WriteDocument,
      description: "Create or update a Document.",
      inputSchema: writeDocumentInput,
      handler: async (input) => wrap(() => vault.tools.writeDocument(compactWriteDocumentInput(writeDocumentInput.parse(input)))),
    },
    {
      name: McpToolName.AppendLog,
      description: "Append an entry to log.md.",
      inputSchema: appendLogInput,
      handler: async (input) => wrap(() => vault.tools.appendLog(compactAppendLogInput(appendLogInput.parse(input)))),
    },
    {
      name: McpToolName.SearchIndex,
      description: "Search the index + page bodies.",
      inputSchema: searchIndexInput,
      handler: async (input) => wrap(() => vault.tools.searchIndex(compactSearchIndexInput(searchIndexInput.parse(input)))),
    },
    {
      name: McpToolName.WikilinkResolve,
      description: "Resolve a wikilink to a Document or null.",
      inputSchema: wikilinkResolveInput,
      handler: async (input) => wrap(() => vault.tools.wikilinkResolve(wikilinkResolveInput.parse(input))),
    },
    {
      name: McpToolName.MoveDocument,
      description: "Move a Document; atomically rewrite incoming wikilinks.",
      inputSchema: moveDocumentInput,
      handler: async (input) => wrap(() => vault.tools.moveDocument(moveDocumentInput.parse(input))),
    },
    {
      name: McpToolName.DeleteDocument,
      description: "Delete a Document.",
      inputSchema: deleteDocumentInput,
      handler: async (input) => wrap(() => vault.tools.deleteDocument(deleteDocumentInput.parse(input))),
    },
  ];
}
