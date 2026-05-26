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
import { projectEffectsToEvents } from "../event-projection";

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
 * Per-Tool parse-and-invoke function (transport-facing). Parses raw input
 * through the entry's Zod schema, compacts via the entry's compact(), and
 * invokes the entry's invoke() function with the vault + writer + input.
 */
type Parser = (input: unknown) => Promise<ToolReturn<unknown>>;

/**
 * Bind every Tool in the registry against a Vault + writer, producing
 * the strict-input `BoundToolSurface` exposed at `vault.tools` and the
 * per-Tool parsers used by transports (MCP today; HTTP / SSE later).
 *
 * Mutating Tools are wrapped intrinsically: after each invoke, the
 * emitted `Effect[]` is projected to `HookEvent[]` and dispatched via
 * `vault.dispatchEvents`. The wrap is a property of the Vault, not a
 * parameter — every projection of vault.tools (renderMcp consuming
 * surface.tools; projectAiSdk consuming wrapMutatingInvoke; future
 * renderHttp / renderVoice) gets hook-dispatch for free. Read-only Tools (read,
 * search, resolve) are exposed unwrapped (they emit no effects).
 *
 * Closure timing: the wrap reads `vault.dispatchEvents` lazily at invoke
 * time. openVault calls `bindTools(partial, ...)` where `partial` carries
 * `dispatchEvents` already; the captured reference is set before any Tool
 * fires. See docs/wiki/specs/sdk-surface.md §"Hook dispatch is intrinsic".
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

/**
 * Single-source hook-dispatch wrap. Every projection of TOOL_REGISTRY
 * (bindTools → vault.tools; bindAiSdkTools → projectAiSdk(vault); future
 * renderHttp / renderVoice) consumes this helper rather than re-implementing
 * the post-invoke dispatch loop. The wrap is intrinsic to the Vault-bound
 * Tool registry, not a per-call-site decorator.
 *
 * Returns a function taking the entry's compact input shape (post-Zod-parse,
 * post-compact). For projections that receive raw input, wrap this with the
 * entry's schema.parse() and entry.compact() per the bindEntry pattern below.
 *
 * Pins HOOK_DISPATCH_IS_VAULT_BOUND (axiom). See
 * docs/wiki/invariants/HOOK_DISPATCH_IS_VAULT_BOUND.md.
 *
 * **Adding a new projection?** Consume this helper from your projection
 * (do not re-implement the dispatch loop) and ship a parallel integration
 * test alongside the v0.5 pair at tests/integration/mcp-hook-dispatch.test.ts
 * and tests/integration/ai-sdk-hook-dispatch.test.ts. The convention is
 * enforced by reviewer attention until the v0.5.1+ semantic linter
 * (docs/wiki/linters/wrap-mutating-invoke-consumption.md) ships.
 */
export function wrapMutatingInvoke<TParsed, TInput, TOutput>(
  entry: ToolRegistryEntry<TParsed, TInput, TOutput>,
  vault: Vault,
  writer: PrivilegedWriter,
): (input: TInput) => Promise<ToolReturn<TOutput>> {
  if (!entry.mutating) {
    return (input: TInput) => entry.invoke(vault, writer, input);
  }
  return async (input: TInput) => {
    const out = await entry.invoke(vault, writer, input);
    await vault.dispatchEvents(projectEffectsToEvents(out.effects));
    return out;
  };
}

function bindEntry<TParsed, TInput, TOutput>(
  entry: ToolRegistryEntry<TParsed, TInput, TOutput>,
  vault: Vault,
  writer: PrivilegedWriter,
): { tool: (input: TInput) => Promise<ToolReturn<TOutput>>; parser: Parser } {
  const tool = wrapMutatingInvoke(entry, vault, writer);
  return {
    tool,
    parser: async (raw: unknown) => {
      const parsed = entry.schema.parse(raw);
      const compacted = entry.compact(parsed);
      return tool(compacted);
    },
  };
}

export function bindTools(vault: Vault, writer: PrivilegedWriter): BoundTools {
  const tools = {} as Record<string, (input: unknown) => Promise<ToolReturn<unknown>>>;
  const parsers = {} as Record<string, Parser>;
  for (const name of TOOL_NAMES) {
    // TOOL_REGISTRY[name] is a union of entry shapes; bindEntry's generics
    // can't narrow across the union, so we cast to the wide entry type.
    // The runtime check inside bindEntry (entry.mutating) keeps the wrap
    // logic correct regardless of the static type.
    const entry = TOOL_REGISTRY[name] as ToolRegistryEntry;
    const { tool, parser } = bindEntry(entry, vault, writer);
    tools[name] = tool as (input: unknown) => Promise<ToolReturn<unknown>>;
    parsers[name] = parser;
  }
  return {
    tools: tools as unknown as BoundToolSurface,
    parsers: parsers as Record<ToolName, Parser>,
  };
}
