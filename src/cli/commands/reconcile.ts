import { openVault } from "../../vault";
import { reconcile } from "../../reconcile";
import type { Result, ToolError } from "../../types";

export async function domeReconcile(
  vaultPath: string,
): Promise<Result<{ inboxProcessed: number; changedFiles: number; scheduledFired: number }, ToolError>> {
  const res = await openVault(vaultPath);
  if (!res.ok) return res;
  return reconcile(res.value, { onEvent: () => {} });
}
