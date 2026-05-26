import { openVault } from "../../vault";
import { reconcile } from "../../reconcile";
import { VaultWatcher } from "../../watcher";
import { DomeMcpServer } from "../../mcp/server";
import { ok, type Result, type ToolError } from "../../types";

export interface ServeHandle {
  stop: () => Promise<void>;
  vaultPath: string;
  server: DomeMcpServer;
}

export async function domeServe(vaultPath: string): Promise<Result<ServeHandle, ToolError>> {
  const res = await openVault(vaultPath);
  if (!res.ok) return res;
  const vault = res.value;
  // Auto-reconcile at startup.
  const rec = await reconcile(vault, { onEvent: () => {} });
  if (!rec.ok) return rec;
  // Start watcher.
  const watcher = new VaultWatcher(vault.path, () => {});
  await watcher.start();
  // Build server (caller can drive serveStdio if desired).
  const server = new DomeMcpServer({ vault });
  return ok({
    stop: async () => { await watcher.stop(); },
    vaultPath: vault.path,
    server,
  });
}
