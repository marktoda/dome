import type { Dispatcher } from "./dispatcher";
import type { readDocument } from "./tools/read-document";
import type { writeDocument } from "./tools/write-document";
import type { appendLog } from "./tools/append-log";
import type { searchIndex } from "./tools/search-index";
import type { wikilinkResolve } from "./tools/wikilink-resolve";
import type { moveDocument } from "./tools/move-document";
import type { deleteDocument } from "./tools/delete-document";

// Tool surface bound to a specific Vault.
export interface ReadonlyToolSurface {
  readDocument: typeof readDocument extends (v: any, ...args: infer A) => infer R ? (...args: A) => R : never;
  writeDocument: typeof writeDocument extends (v: any, d: any, ...args: infer A) => infer R ? (...args: A) => R : never;
  appendLog: typeof appendLog extends (v: any, d: any, ...args: infer A) => infer R ? (...args: A) => R : never;
  searchIndex: typeof searchIndex extends (v: any, ...args: infer A) => infer R ? (...args: A) => R : never;
  wikilinkResolve: typeof wikilinkResolve extends (v: any, ...args: infer A) => infer R ? (...args: A) => R : never;
  moveDocument: typeof moveDocument extends (v: any, d: any, ...args: infer A) => infer R ? (...args: A) => R : never;
  deleteDocument: typeof deleteDocument extends (v: any, d: any, ...args: infer A) => infer R ? (...args: A) => R : never;
}

export interface HookContext {
  readonly tools: ReadonlyToolSurface;
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
