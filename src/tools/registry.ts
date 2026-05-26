// The canonical Tool registry — the single source of truth for "the seven
// Tools." Every downstream catalog (BoundToolSurface, MCP names, AI-SDK tool
// set, workflow-frontmatter Zod enum, MCP adapter list) derives from this
// one array.
//
// Adding an 8th Tool used to touch 9 files; with this registry it touches
// two: a new `src/tools/<name>.ts` Tool implementation + one entry below.
//
// Each entry is shaped around the AI SDK's native `Tool<INPUT, OUTPUT>` type
// — we don't invent a "ToolDescriptor" wrapper. The AI SDK already names
// the right fields (description, inputSchema, execute). Our registry adds
// only what the SDK doesn't carry: a canonical name, an MCP name, a factory
// that binds the Tool to a Vault + PrivilegedWriter, and a mutation flag
// used by the per-workflow commit collector.

import { tool, type Tool, type ToolSet } from "ai";
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
// Each entry binds a raw Tool function to a Vault + (optionally) the
// PrivilegedWriter, producing the curried function `Vault.tools[name]`
// exposes. The same currying flows into the AI SDK `Tool<>` via the factory
// helper — so the AI SDK consumer, the MCP consumer, and the Vault consumer
// all share one path to the underlying Tool.

/**
 * A registry entry. Stored as a factory that takes the Vault + privileged
 * writer (because mutating Tools need the writer and consumers should never
 * touch it). Returns the AI-SDK-native `Tool<>` plus the curried Vault-bound
 * function used by `vault.tools[name]`.
 */
interface ToolRegistryEntry<I = unknown, O = unknown> {
  readonly description: string;
  /** True iff the Tool produces on-disk state changes; drives per-workflow commit collection. */
  readonly mutating: boolean;
  /**
   * Returns an AI SDK `Tool<I, O>` plus the curried Vault-bound functions.
   * One call per `openVault` — the resulting objects flow to every consumer.
   *
   * - `tool`: AI SDK `Tool<>` consumed by `generateText`. Its `execute`
   *   already does Zod parse + compaction + invoke.
   * - `bound(input)`: the strict-input function exposed at `vault.tools[name]`.
   *   No parsing — callers pass an already-typed input.
   * - `parseAndInvoke(input)`: parse-then-compact-then-invoke. Used by the
   *   MCP adapter and any other transport that delivers raw JSON.
   */
  readonly bind: (vault: Vault, writer: PrivilegedWriter) => {
    tool: Tool<I, O>;
    bound: (input: I) => Promise<ToolReturn<O>>;
    parseAndInvoke: (input: unknown) => Promise<ToolReturn<O>>;
  };
}

/**
 * Helper that builds a registry entry from the AI SDK schemas + the raw Tool
 * function. Reduces boilerplate so each registry entry is 1-3 lines.
 */
function entry<TParsed, TInput, TOutput>(opts: {
  description: string;
  mutating: boolean;
  schema: import("zod").ZodType<TParsed>;
  /** Compact the parsed Zod object into the Tool's strict input shape. */
  compact: (parsed: TParsed) => TInput;
  /** The raw Tool function from `src/tools/<name>.ts`. */
  invoke: (vault: Vault, writer: PrivilegedWriter, input: TInput) => Promise<ToolReturn<TOutput>>;
}): ToolRegistryEntry<TInput, TOutput> {
  return {
    description: opts.description,
    mutating: opts.mutating,
    bind(vault, writer) {
      const bound = (input: TInput) => opts.invoke(vault, writer, input);
      const parseAndInvoke = (input: unknown) => bound(opts.compact(opts.schema.parse(input)));
      const aiTool = tool({
        description: opts.description,
        inputSchema: opts.schema,
        execute: async (parsed: TParsed) => bound(opts.compact(parsed)),
      }) as unknown as Tool<TInput, TOutput>;
      return { tool: aiTool, bound, parseAndInvoke };
    },
  };
}

/** Read-only Tools need no writer; this adapter drops it from the signature. */
function readOnly<TParsed, TInput, TOutput>(opts: {
  description: string;
  schema: import("zod").ZodType<TParsed>;
  compact: (parsed: TParsed) => TInput;
  invoke: (vault: Vault, input: TInput) => Promise<ToolReturn<TOutput>>;
}): ToolRegistryEntry<TInput, TOutput> {
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
  // `satisfies` with a loose-variance bound: enforces that every ToolName
  // has an entry without forcing the generic parameters of each entry to
  // align (which fails under exactOptionalPropertyTypes + AI SDK's Tool<I,O>
  // variance). The exact types are preserved for `TOOL_REGISTRY[name].bind`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<ToolName, ToolRegistryEntry<any, any>>;

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

/**
 * Bind every Tool in the registry against a Vault + writer, producing:
 *
 *   - `tools`: the curried `BoundToolSurface` exposed at `vault.tools`
 *   - `aiTools`: the AI SDK `ToolSet` used by `runWorkflow` / `generateText`
 *
 * One call per `openVault`. Both halves share the same compaction + invoke
 * path so the AI SDK consumer and the Vault consumer cannot diverge.
 *
 * `wrapMutating` (optional) decorates only the mutating Tools' Vault-side
 * functions — the AI SDK tools are exposed unwrapped because the agent loop
 * already drives them through the same Vault.tools surface where the
 * wrapping happens at the SDK consumer's side, not the registry's. Keeping
 * the AI SDK exposure raw means generateText sees one path, and the wrap
 * happens once (at vault binding) rather than twice (at vault and at SDK).
 */
export interface BoundTools {
  /** Curried `BoundToolSurface` exposed at `vault.tools`. Strict-input. */
  tools: BoundToolSurface;
  /** AI SDK `ToolSet` for `generateText` / `streamText`. */
  aiTools: ToolSet;
  /**
   * Per-Tool `parseAndInvoke(input: unknown)` functions, keyed by canonical
   * Tool name. Used by transports (MCP, future HTTP) that deliver raw input
   * — they parse + compact + invoke in one call.
   */
  parsers: Readonly<Record<ToolName, (input: unknown) => Promise<ToolReturn<unknown>>>>;
}

export function bindTools(
  vault: Vault,
  writer: PrivilegedWriter,
  wrapMutating: MutatingWrapper = identityWrap,
): BoundTools {
  const tools = {} as Record<string, (input: unknown) => Promise<ToolReturn<unknown>>>;
  const aiTools: ToolSet = {};
  const parsers = {} as Record<string, (input: unknown) => Promise<ToolReturn<unknown>>>;
  for (const name of TOOL_NAMES) {
    const entry = TOOL_REGISTRY[name];
    const { tool: aiTool, bound, parseAndInvoke } = entry.bind(vault, writer);
    const exposed = entry.mutating
      ? (wrapMutating as MutatingWrapper)(bound as (input: unknown) => Promise<ToolReturn<unknown>>)
      : bound;
    tools[name] = exposed as (input: unknown) => Promise<ToolReturn<unknown>>;
    aiTools[name] = aiTool;
    // Apply the same mutating wrapper to parseAndInvoke so MCP-routed calls
    // also flow through the hook dispatcher; otherwise the SDK consumer
    // (Vault.tools.*) and the MCP consumer diverge on hook firing.
    const parser = parseAndInvoke as (input: unknown) => Promise<ToolReturn<unknown>>;
    parsers[name] = entry.mutating
      ? (wrapMutating as MutatingWrapper)(parser)
      : parser;
  }
  return {
    tools: tools as unknown as BoundToolSurface,
    aiTools,
    parsers: parsers as Record<ToolName, (input: unknown) => Promise<ToolReturn<unknown>>>,
  };
}

const identityWrap: MutatingWrapper = (fn) => fn;

/**
 * Filter the bound AI tool set to only the names a workflow declares in its
 * frontmatter `tools:` list. Unknown names are silently dropped (matches
 * v0.5 behavior for forward-compatibility with future plugin tools).
 */
export function filterAiTools(aiTools: ToolSet, allowedNames: ReadonlyArray<string>): ToolSet {
  const out: ToolSet = {};
  for (const name of allowedNames) {
    const t = aiTools[name];
    if (t !== undefined) out[name] = t;
  }
  return out;
}
