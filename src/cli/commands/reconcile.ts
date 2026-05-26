import { openVault } from "../../vault";
import { reconcile } from "../../reconcile";
import type { Result, ToolError } from "../../types";

export async function domeReconcile(
  vaultPath: string,
): Promise<Result<{ inboxProcessed: number; changedFiles: number; scheduledFired: number }, ToolError>> {
  const res = await openVault(vaultPath);
  if (!res.ok) return res;
  const vault = res.value;
  // Route every event reconcile fires through the vault's dispatcher so the
  // shipped-default hooks (auto-update-index) and YAML-declared intake hooks
  // (intake-raw.yaml → ingest workflow) actually run. Without this routing,
  // reconcile would fire events into the void.
  const result = await reconcile(vault, {
    onEvent: (event) => vault.dispatchEvents([event]),
  });
  // Wait for async hooks to settle so the CLI exits with a deterministic
  // state. Without drainHooks the process can exit while p-queue still has
  // work scheduled, losing the tail of any inbox processing.
  await vault.drainHooks();
  return result;
}
