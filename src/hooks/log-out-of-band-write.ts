import type { HookHandler } from "../hook-context";

/**
 * Shipped-default hook. Subscribes to `vault.out-of-band-edit` events fired by
 * the VaultWatcher and records each native write to log.md via appendLog —
 * the watcher leg of the external-path enforcement of EVERY_WRITE_IS_LOGGED per
 * docs/wiki/invariants/VAULT_RECONCILES_AFTER_NATIVE_WRITE.md.
 *
 * The reconcile leg is enforced separately in src/reconcile.ts phase-2 (it
 * calls vault.tools.appendLog directly per replayed file). The two legs are
 * kept structurally separate because document.written.* events are emitted
 * by both Tool-mediated writes (via wrapMutatingInvoke) and reconcile —
 * subscribing this hook to that pattern would double-log Tool writes.
 *
 * HOOKS_CANNOT_BYPASS_TOOLS: this hook observes events and calls a Tool
 * (appendLog); it never writes directly. Skips dispatcher-owned paths
 * (log.md / index.md) to avoid cycles with the privileged writers.
 */
export const logOutOfBandWrite: HookHandler = async (event, ctx) => {
  if (event.kind !== "vault.out-of-band-edit") return;
  const path = (event as { path?: string }).path;
  if (typeof path !== "string") return;
  if (path === "log.md" || path === "index.md") return;
  const fsKind = (event as { fsKind?: string }).fsKind ?? "modified";
  await ctx.tools.appendLog({
    verb: "update",
    subject: `${path} (out-of-band, ${fsKind})`,
  });
};
