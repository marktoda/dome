import type { HookHandler } from "../hook-context";
import { basename } from "node:path";

/**
 * Shipped-default hook. Reacts to wiki-write/delete events from three sources:
 *   - `document.written.wiki.*` / `document.deleted.wiki.*` — Tool-mediated writes
 *   - `vault.out-of-band-edit` (with `fsKind` discriminator) — watcher-driven
 *     native writes, per docs/wiki/invariants/VAULT_RECONCILES_AFTER_NATIVE_WRITE.md
 *     §"Structural enforcement" path 1.
 *
 * The PrivilegedWriter API is the only allowed writer for `index.md`
 * (INDEX_AND_LOG_ARE_DISPATCHER_OWNED). Non-wiki paths (inbox/, raw/, notes/)
 * are silently skipped — the index is wiki-only.
 */
export const autoUpdateIndex: HookHandler = async (event, ctx) => {
  if (!ctx.privilegedWriter) return;
  const path = event.path;
  if (typeof path !== "string") return;

  if (event.kind === "vault.out-of-band-edit") {
    // Watcher path: discriminate by fsKind, filter to wiki/ content.
    if (!path.startsWith("wiki/")) return;
    const fsKind = (event as { fsKind?: string }).fsKind ?? "modified";
    if (fsKind === "deleted") {
      await ctx.privilegedWriter.removeIndexEntry(path);
    } else {
      await ctx.privilegedWriter.writeIndex({ path, title: titleFromPath(path) });
    }
    return;
  }

  if (event.kind.startsWith("document.deleted.")) {
    await ctx.privilegedWriter.removeIndexEntry(path);
    return;
  }

  const title = titleFromPath(path);
  await ctx.privilegedWriter.writeIndex({ path, title });
};

function titleFromPath(path: string): string {
  const base = basename(path).replace(/\.md$/, "");
  return base.split("-").map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(" ");
}
