import type { HookHandler } from "../hook-context";

/**
 * Shipped-default hook. Subscribes to both:
 *   - `vault.out-of-band-edit` events fired by the VaultWatcher (live path)
 *   - `document.written.wiki.*` events fired by `dome reconcile` (catch-up path)
 *
 * Each native write is recorded to log.md via appendLog — the external-path
 * enforcement of EVERY_WRITE_IS_LOGGED per
 * docs/wiki/invariants/VAULT_RECONCILES_AFTER_NATIVE_WRITE.md.
 *
 * HOOKS_CANNOT_BYPASS_TOOLS: this hook observes events and calls a Tool
 * (appendLog); it never writes directly. Skips dispatcher-owned paths
 * (log.md / index.md) to avoid cycles with the privileged writers.
 *
 * Subscription patterns are registered in src/vault.ts as one handler against
 * two patterns; this handler discriminates by event.kind.
 */
export const logOutOfBandWrite: HookHandler = async (event, ctx) => {
  const path = (event as { path?: string }).path;
  if (typeof path !== "string") return;
  if (path === "log.md" || path === "index.md") return;

  let source: string;
  if (event.kind === "vault.out-of-band-edit") {
    const fsKind = (event as { fsKind?: string }).fsKind ?? "modified";
    source = `out-of-band, ${fsKind}`;
  } else if (event.kind.startsWith("document.written.")) {
    // Reconcile path. Tag the entry with "out-of-band, reconcile" so a
    // reader of log.md can distinguish live-watched writes from catch-up.
    source = "out-of-band, reconcile";
  } else {
    return;
  }

  await ctx.tools.appendLog({
    verb: "update",
    subject: `${path} (${source})`,
  });
};
