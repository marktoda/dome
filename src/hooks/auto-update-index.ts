import type { HookHandler } from "../hook-context";
import { basename } from "node:path";

/**
 * Shipped-default hook. Reacts to both `document.written.wiki.*` and
 * `document.deleted.wiki.*` events — adds an index entry on write, removes
 * it on delete. The privileged dispatcher API is the only allowed writer
 * for index.md (INDEX_AND_LOG_ARE_DISPATCHER_OWNED).
 */
export const autoUpdateIndex: HookHandler = async (event, ctx) => {
  if (!ctx.dispatcher) return; // privileged API only available to built-in handlers
  const path = event.path;
  if (typeof path !== "string") return;

  if (event.kind.startsWith("document.deleted.")) {
    await ctx.dispatcher.removeIndexEntry(path);
    return;
  }

  const title = titleFromPath(path);
  await ctx.dispatcher.writeIndex({ path, title });
};

function titleFromPath(path: string): string {
  const base = basename(path).replace(/\.md$/, "");
  return base.split("-").map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(" ");
}
