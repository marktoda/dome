import { openVault } from "../../vault";
import { reconcile } from "../../reconcile";
import { VaultWatcher } from "../../watcher";
import { DomeMcpServer } from "../../mcp/server";
import { renderMcp, type McpSurface } from "../../mcp/render-mcp";
import { buildAbstractSurface } from "../../abstract-surface";
import { ok, type Result, type ToolError } from "../../types";

export interface ServeHandle {
  vaultPath: string;
  server: DomeMcpServer;
  /**
   * The McpSurface the server was constructed from. Exposed so callers
   * (and tests) can introspect prompts/resources/instructions without
   * reaching through the server's protocol-specific shape.
   */
  surface: McpSurface;
  /**
   * Stop the watcher. The MCP server, once connected to its stdio transport
   * via `connectStdio: true`, runs until the parent process closes stdin (the
   * Claude Code / Cursor harness exits, or the user Ctrl-C's the daemon).
   * Tests pass `connectStdio: false` so the server stays inspectable without
   * actually claiming stdio.
   */
  stop: () => Promise<void>;
}

export interface DomeServeOpts {
  /**
   * Connect the MCP server to stdio. True in production (the CLI shim sets
   * this); false in tests (so they can drive the server's adapter arrays
   * without claiming the test runner's stdio).
   */
  connectStdio?: boolean;
}

export async function domeServe(
  vaultPath: string,
  opts: DomeServeOpts = {},
): Promise<Result<ServeHandle, ToolError>> {
  const res = await openVault(vaultPath);
  if (!res.ok) return res;
  const vault = res.value;
  // Auto-reconcile at startup; route events through the vault's hook
  // dispatcher so the YAML-declared intake hooks (e.g., intake-raw.yaml)
  // actually fire on inbox files present at boot.
  const rec = await reconcile(vault, {
    onEvent: (event) => vault.dispatchEvents([event]),
  });
  if (!rec.ok) return rec;
  // Drain the startup-reconcile's async work before opening up to live
  // events, so the harness sees a deterministic post-catchup state.
  await vault.drainHooks();
  // Start watcher for out-of-band edits; route each one through the vault's
  // dispatcher so doctor's OOB-detection and any vault.out-of-band-edit
  // subscribers actually receive them.
  const watcher = new VaultWatcher(vault.path, (event) => {
    void vault.dispatchEvents([event]);
  });
  await watcher.start();
  // Build the AbstractSurface (protocol-agnostic four-kind aggregation
  // per docs/wiki/specs/sdk-surface.md §"Consumer surfaces") then render
  // it to McpSurface (MCP wire shape) and construct the MCP server as
  // a thin protocol adapter over the rendered surface. Without
  // serveStdio() the constructed server registers no handlers on any
  // transport and the harness sees an empty surface.
  const abstractSurface = await buildAbstractSurface(vault);
  const surface = renderMcp(abstractSurface);
  const server = new DomeMcpServer({ surface });
  if (opts.connectStdio !== false) {
    await server.serveStdio();
  }
  return ok({
    vaultPath: vault.path,
    server,
    surface,
    stop: async () => { await watcher.stop(); },
  });
}
