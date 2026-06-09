// cli/commands/mcp: `dome mcp` — the stdio MCP server (wedge Phase 5).
//
// Per docs/wiki/specs/cli.md §"dome mcp" + docs/wiki/specs/mcp-surface.md,
// this verb hosts the Dome MCP protocol adapter over stdio for one vault.
// The server is a read/capture surface: it runs no adoption loop and no
// scheduler (the daemon owns compilation); its tools call the same command
// handlers the CLI verbs use.
//
// Boundary notes:
//
//   - stdout is the MCP protocol channel. Everything this module prints
//     goes to stderr (console.error). The adapter itself captures handler
//     console output per tool call, so command JSON cannot leak onto the
//     wire.
//   - This module statically imports @modelcontextprotocol/sdk (via
//     src/mcp/server.ts). The Commander dispatcher loads it with a dynamic
//     `import("./commands/mcp")` so the CLI's static import graph stays
//     MCP-free — the same companion-entrypoint discipline pinned by
//     ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY for src/index.ts.
//
// House-style notes (matches src/cli/commands/capture.ts):
//   - `type X = { ... }` aliases, every field `readonly`.
//   - The handler returns the exit code; the dispatcher calls
//     `process.exit(code)` — though for `dome mcp` the handler returns only
//     after the client disconnects.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { findGitRoot } from "../../git";
import { createDomeMcpServer } from "../../mcp/server";

const EX_USAGE = 64;

export type RunMcpOptions = {
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
};

/**
 * Execute `dome mcp`. Serves MCP over stdio until the client disconnects
 * (stdin closes). Returns the exit code: 0 on clean shutdown; 64 (EX_USAGE)
 * when the target is not an initialized Dome vault; 1 on transport failure.
 */
export async function runMcp(options: RunMcpOptions = {}): Promise<number> {
  const vaultPath = resolve(options.vault ?? process.cwd());

  const gitRoot = await findGitRoot(vaultPath);
  if (gitRoot === null || !existsSync(join(vaultPath, ".dome", "config.yaml"))) {
    console.error(
      `dome mcp: not an initialized Dome vault (missing ${
        gitRoot === null ? "git repository" : ".dome/config.yaml"
      }); run \`dome init\` first`,
    );
    return EX_USAGE;
  }

  try {
    const server = createDomeMcpServer({
      vaultPath,
      ...(options.bundlesRoot !== undefined
        ? { bundlesRoot: options.bundlesRoot }
        : {}),
    });
    const transport = new StdioServerTransport();
    // Hold the process open until the client disconnects. Two subtleties:
    //
    //   1. The SDK's StdioServerTransport never watches stdin for EOF — it
    //      only fires onclose from an explicit close() call — so a client
    //      that simply closes our stdin would leave the process hanging
    //      forever. Listen for stdin 'end'/'close' ourselves.
    //   2. Register the handlers BEFORE connect: a client that disconnects
    //      during/immediately after the handshake would otherwise race the
    //      handler assignment and hang the process.
    const closed = new Promise<void>((done) => {
      server.server.onclose = () => done();
      process.stdin.once("end", () => done());
      process.stdin.once("close", () => done());
    });
    await server.connect(transport);
    console.error(`dome mcp: serving vault ${vaultPath} over stdio`);
    await closed;
    await server.close().catch(() => {});
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`dome mcp: failed: ${msg}`);
    return 1;
  }
}
