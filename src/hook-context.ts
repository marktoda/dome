import type { Dispatcher } from "./dispatcher";
import { type readDocument, type ReadDocumentInput } from "./tools/read-document";
import { type writeDocument, type WriteDocumentInput } from "./tools/write-document";
import { type appendLog, type AppendLogInput } from "./tools/append-log";
import { type searchIndex, type SearchIndexInput } from "./tools/search-index";
import { type wikilinkResolve, type WikilinkResolveInput } from "./tools/wikilink-resolve";
import { type moveDocument, type MoveDocumentInput } from "./tools/move-document";
import { type deleteDocument, type DeleteDocumentInput } from "./tools/delete-document";

/**
 * The Vault-bound Tool surface. The single canonical type for "the seven Tools
 * with their Vault/Dispatcher already curried in", reused by both
 * `Vault.tools` (callers from the SDK boundary) and `HookContext.tools` (built-in
 * and plugin hook handlers).
 *
 * Previously expressed as two near-identical shapes: BoundToolSurface in
 * vault.ts and ReadonlyToolSurface in hook-context.ts (the latter via a
 * conditional-type extractor). Unified here so a new Tool added to the SDK
 * surface flows through one type.
 */
export interface BoundToolSurface {
  readDocument: (input: ReadDocumentInput) => ReturnType<typeof readDocument>;
  writeDocument: (input: WriteDocumentInput) => ReturnType<typeof writeDocument>;
  appendLog: (input: AppendLogInput) => ReturnType<typeof appendLog>;
  searchIndex: (input: SearchIndexInput) => ReturnType<typeof searchIndex>;
  wikilinkResolve: (input: WikilinkResolveInput) => ReturnType<typeof wikilinkResolve>;
  moveDocument: (input: MoveDocumentInput) => ReturnType<typeof moveDocument>;
  deleteDocument: (input: DeleteDocumentInput) => ReturnType<typeof deleteDocument>;
}

export interface HookContext {
  readonly tools: BoundToolSurface;
  readonly vault: { readonly path: string };
  readonly dispatcher?: Dispatcher;
}

export interface HookEvent {
  readonly kind: string;
  readonly path?: string;
  readonly diff?: string;
  readonly [key: string]: unknown;
}

export type HookHandler<E extends HookEvent = HookEvent> = (event: E, ctx: HookContext) => Promise<void>;
