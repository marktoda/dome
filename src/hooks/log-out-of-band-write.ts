import type { HookHandler } from "../hook-context";

/**
 * Shipped-default hook. Subscribes to `vault.out-of-band-edit` events fired by
 * the VaultWatcher and records each native write to log.md via appendLog —
 * the external-path enforcement of EVERY_WRITE_IS_LOGGED per
 * docs/wiki/invariants/VAULT_RECONCILES_AFTER_NATIVE_WRITE.md.
 *
 * HOOKS_CANNOT_BYPASS_TOOLS: this hook observes events and calls a Tool
 * (appendLog); it never writes directly. Skips log.md / index.md to avoid
 * cycles with the dispatcher-owned writers.
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
