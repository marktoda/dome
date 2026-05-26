// The canonical Tool registry — the single source of truth for "the seven
// Tools." Every downstream catalog (BoundToolSurface, MCP names, AI-SDK tool
// set, workflow-frontmatter Zod enum, MCP adapter list) derives from this
// one array.
//
// Phase B split: this module is part of @dome/sdk core and contains NO
// dependency on `ai` (Vercel AI SDK). The AI-SDK Tool<> construction +
// `filterAiTools` live in src/tools/ai-sdk-binding.ts (imported only by
// @dome/sdk/workflows and @dome/sdk/mcp consumers). This is what makes
// CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY structurally true.
//
// Adding an 8th Tool still touches two files: a new src/tools/<name>.ts
// implementation + one new entry below.

import type { Vault } from "../vault";
import type { PrivilegedWriter } from "../privileged-writer";
import type { BoundToolSurface } from "../hook-context";
import type { ToolReturn } from "../types";

import { readDocument } from "./read-document";
import { writeDocument } from "./write-document";
import { appendLog } from "./append-log";
import { searchIndex } from "./search-index";
import { wikilinkResolve } from "./wikilink-resolve";
import { moveDocument } from "./move-document";
import { deleteDocument } from "./delete-document";

import {
  readDocumentInput,
  writeDocumentInput,
  appendLogInput,
  searchIndexInput,
  wikilinkResolveInput,
  moveDocumentInput,
  deleteDocumentInput,
  compactWriteDocumentInput,
  compactAppendLogInput,
  compactSearchIndexInput,
  compactMoveDocumentInput,
  compactDeleteDocumentInput,
} from "./schemas";

// ----- Tool names (canonical + MCP) ----------------------------------------

/** The seven canonical Tool names. The single source — derive everything else from here. */
export const TOOL_NAMES = [
  "readDocument",
  "writeDocument",
  "appendLog",
  "searchIndex",
  "wikilinkResolve",
  "moveDocument",
  "deleteDocument",
] as const;
export type ToolName = typeof TOOL_NAMES[number];

/** MCP exposes tools under a `dome.*` prefix with snake_case identifiers. */
export const MCP_TOOL_NAMES: Readonly<Record<ToolName, string>> = {
  readDocument: "dome.read_document",
  writeDocument: "dome.write_document",
  appendLog: "dome.append_log",
  searchIndex: "dome.search_index",
  wikilinkResolve: "dome.wikilink_resolve",
  moveDocument: "dome.move_document",
  deleteDocument: "dome.delete_document",
};

// ----- The registry --------------------------------------------------------

/**
 * Registry entry — metadata only. Carries the description, the mutating
 * flag, the Zod schema, the compact() function (parsed → strict input),
 * and the raw invoke() function. The AI-SDK `Tool<>` construction lives
 * in src/tools/ai-sdk-binding.ts; this module stays AI-SDK-free for the
 * core entrypoint's sake.
 */
export interface ToolRegistryEntry<TParsed = unknown, TInput = unknown, TOutput = unknown> {
  readonly description: string;
  /** True iff the Tool produces on-disk state changes; drives per-workflow commit collection. */
  readonly mutating: boolean;
  /** Zod schema for the parsed input shape (pre-compaction). */
  readonly schema: import("zod").ZodType<TParsed>;
  /** Compact the parsed Zod object into the Tool's strict input shape. */
  readonly compact: (parsed: TParsed) => TInput;
  /**
   * The raw Tool function. Takes a writer; readOnly entries internally
   * drop the writer arg via the readOnly() helper.
   */
  readonly invoke: (vault: Vault, writer: PrivilegedWriter, input: TInput) => Promise<ToolReturn<TOutput>>;
}

function entry<TParsed, TInput, TOutput>(opts: {
  description: string;
  mutating: boolean;
  schema: import("zod").ZodType<TParsed>;
  compact: (parsed: TParsed) => TInput;
  invoke: (vault: Vault, writer: PrivilegedWriter, input: TInput) => Promise<ToolReturn<TOutput>>;
}): ToolRegistryEntry<TParsed, TInput, TOutput> {
  return opts;
}

function readOnly<TParsed, TInput, TOutput>(opts: {
  description: string;
  schema: import("zod").ZodType<TParsed>;
  compact: (parsed: TParsed) => TInput;
  invoke: (vault: Vault, input: TInput) => Promise<ToolReturn<TOutput>>;
}): ToolRegistryEntry<TParsed, TInput, TOutput> {
  return entry({
    description: opts.description,
    mutating: false,
    schema: opts.schema,
    compact: opts.compact,
    invoke: (vault, _writer, input) => opts.invoke(vault, input),
  });
}

const identity = <T>(x: T): T => x;

/**
 * The canonical Tool registry. The seven entries here are the single source
 * of truth — `BoundToolSurface`, the MCP adapter list, the AI SDK tool set,
 * and the workflow-frontmatter Zod enum all derive from this object.
 */
export const TOOL_REGISTRY = {
  readDocument: readOnly({
    description: "Read a Document by path.",
    schema: readDocumentInput,
    compact: identity,
    invoke: (vault, input) => readDocument(vault, input),
  }),

  writeDocument: entry({
    description: "Create or update a Document. Refuses raw/ paths.",
    mutating: true,
    schema: writeDocumentInput,
    compact: compactWriteDocumentInput,
    invoke: (vault, writer, input) => writeDocument(vault, writer, input),
  }),

  appendLog: entry({
    description: "Append an entry to log.md.",
    mutating: true,
    schema: appendLogInput,
    compact: compactAppendLogInput,
    invoke: (vault, writer, input) => appendLog(vault, writer, input),
  }),

  searchIndex: readOnly({
    description: "Search the index + page bodies for matches.",
    schema: searchIndexInput,
    compact: compactSearchIndexInput,
    invoke: (vault, input) => searchIndex(vault, input),
  }),

  wikilinkResolve: readOnly({
    description: "Resolve a full-path wikilink to a Document or null.",
    schema: wikilinkResolveInput,
    compact: identity,
    invoke: (vault, input) => wikilinkResolve(vault, input),
  }),

  moveDocument: entry({
    description: "Move a Document; atomically rewrites incoming wikilinks.",
    mutating: true,
    schema: moveDocumentInput,
    compact: compactMoveDocumentInput,
    invoke: (vault, writer, input) => moveDocument(vault, writer, input),
  }),

  deleteDocument: entry({
    description: "Delete a Document.",
    mutating: true,
    schema: deleteDocumentInput,
    compact: compactDeleteDocumentInput,
    invoke: (vault, writer, input) => deleteDocument(vault, writer, input),
  }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<ToolName, ToolRegistryEntry<any, any, any>>;

// ----- Derived shapes ------------------------------------------------------

/** The set of Tool names that produce on-disk state changes. */
export const MUTATING_TOOL_NAMES: ReadonlySet<ToolName> = new Set(
  TOOL_NAMES.filter(name => TOOL_REGISTRY[name].mutating),
);

/**
 * Optional post-bind decorator that wraps every mutating Tool's invocation
 * before exposing it on `Vault.tools`. The Vault uses this to project a
 * Tool's emitted `Effect[]` into the hook dispatcher; read-only Tools are
 * untouched (they emit no effects worth projecting). Without a wrapper,
 * binding is the identity — the Tool function is exposed directly.
 */
export type MutatingWrapper = <I, R extends ToolReturn<unknown>>(
  fn: (input: I) => Promise<R>,
) => (input: I) => Promise<R>;

const identityWrap: MutatingWrapper = (fn) => fn;

/**
 * Per-Tool parse-and-invoke function (transport-facing). Parses raw input
 * through the entry's Zod schema, compacts via the entry's compact(), and
 * invokes the entry's invoke() function with the vault + writer + input.
 */
type Parser = (input: unknown) => Promise<ToolReturn<unknown>>;

function makeParser(entry: ToolRegistryEntry, vault: Vault, writer: PrivilegedWriter): Parser {
  return async (input: unknown): Promise<ToolReturn<unknown>> => {
    const parsed = entry.schema.parse(input);
    const compacted = entry.compact(parsed);
    return entry.invoke(vault, writer, compacted);
  };
}

/**
 * Bind every Tool in the registry against a Vault + writer, producing
 * the strict-input `BoundToolSurface` exposed at `vault.tools` and the
 * per-Tool parsers used by transports (MCP today; HTTP / SSE later).
 * Both halves share the same compaction + invoke path.
 *
 * `wrapMutating` (optional) decorates only the mutating Tools — read-only
 * Tools (read, search, resolve) are exposed unwrapped (they emit no
 * effects worth projecting through the hook dispatcher).
 *
 * This function is part of @dome/sdk core (no `ai` dependency). The
 * AI-SDK `ToolSet` shape lives in `src/tools/ai-sdk-binding.ts`.
 */
export interface BoundTools {
  /** Curried `BoundToolSurface` exposed at `vault.tools`. Strict-input. */
  tools: BoundToolSurface;
  /**
   * Per-Tool `parseAndInvoke(input: unknown)` functions, keyed by canonical
   * Tool name. Used by transports (MCP, future HTTP) that deliver raw input.
   */
  parsers: Readonly<Record<ToolName, Parser>>;
}

export function bindTools(
  vault: Vault,
  writer: PrivilegedWriter,
  wrapMutating: MutatingWrapper = identityWrap,
): BoundTools {
  const tools = {} as Record<string, (input: unknown) => Promise<ToolReturn<unknown>>>;
  const parsers = {} as Record<string, Parser>;
  for (const name of TOOL_NAMES) {
    const entry = TOOL_REGISTRY[name];
    const bound = (input: unknown) => entry.invoke(vault, writer, input as never);
    const parser = makeParser(entry, vault, writer);
    tools[name] = entry.mutating
      ? (wrapMutating as MutatingWrapper)(bound as (input: unknown) => Promise<ToolReturn<unknown>>)
      : bound;
    parsers[name] = entry.mutating
      ? (wrapMutating as MutatingWrapper)(parser)
      : parser;
  }
  return {
    tools: tools as unknown as BoundToolSurface,
    parsers: parsers as Record<ToolName, Parser>,
  };
}
