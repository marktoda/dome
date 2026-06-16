// cli/commands/ask-server: `dome ask-server` — the ask-my-brain agent backend.
//
// Companion entrypoint for the ask agent HTTP surface.  Same discipline as
// `dome http` and `dome mcp`: this module is ONLY reached via a dynamic import
// in src/cli/index.ts so that src/agent/* (which carries LLM/MCP dependencies)
// never enters the CLI's static import graph.
// ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY is preserved this way.
//
// House-style notes (matches src/cli/commands/http.ts):
//   - `type X = { ... }` aliases, every field `readonly`.
//   - The handler returns the exit code; for `dome ask-server` it returns only
//     when the listener stops (SIGINT/SIGTERM).

import { existsSync } from "node:fs";
import { join } from "node:path";

import { findGitRoot } from "../../git";
import { createAskServer } from "../../agent/server";
import { resolveVaultPath } from "../../surface/resolve-vault";
import { EX_USAGE } from "../exit-codes";

/** Default port: "ask" — 4664 on a phone keypad. */
const DEFAULT_PORT = 4664;
const DEFAULT_HOST = "127.0.0.1";

export type RunAskServerOptions = {
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly port?: string | number | undefined;
  readonly host?: string | undefined;
  readonly token?: string | undefined;
  readonly model?: string | undefined;
  /**
   * Test-only seam: aborting this signal stops the listener and resolves
   * runAskServer with exit 0, exactly like SIGINT/SIGTERM. The CLI never
   * passes it — production shutdown stays signal-driven.
   */
  readonly signal?: AbortSignal | undefined;
  /**
   * Test-only seam: observes the bound listener once it is up (ephemeral
   * `--port 0` discovery). The CLI never passes it.
   */
  readonly onReady?:
    | ((server: { readonly hostname: string; readonly port: number }) => void)
    | undefined;
};

/**
 * Execute `dome ask-server`. Serves the ask agent surface until the process
 * receives SIGINT/SIGTERM. Returns the exit code: 0 on clean shutdown; 64
 * (EX_USAGE) on a missing token, malformed port, or uninitialized vault; 1 on
 * listener failure.
 */
export async function runAskServer(options: RunAskServerOptions = {}): Promise<number> {
  const vaultPath = resolveVaultPath(options.vault);

  const gitRoot = await findGitRoot(vaultPath);
  if (gitRoot === null || !existsSync(join(vaultPath, ".dome", "config.yaml"))) {
    console.error(
      `dome ask-server: not an initialized Dome vault (missing ${
        gitRoot === null ? "git repository" : ".dome/config.yaml"
      }); run \`dome init\` first`,
    );
    return EX_USAGE;
  }

  const token = options.token ?? process.env["DOME_ASK_TOKEN"] ?? "";
  if (token.trim().length === 0) {
    console.error(
      "dome ask-server: a bearer token is required — pass --token <value> or set DOME_ASK_TOKEN.",
    );
    return EX_USAGE;
  }

  const port = options.port === undefined ? DEFAULT_PORT : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`dome ask-server: --port must be an integer in [0, 65535].`);
    return EX_USAGE;
  }

  try {
    const handler = createAskServer({
      vaultPath,
      token,
      ...(options.bundlesRoot !== undefined
        ? { bundlesRoot: options.bundlesRoot }
        : {}),
      ...(options.model !== undefined
        ? { model: options.model }
        : {}),
    });
    const server = Bun.serve({
      hostname: options.host ?? DEFAULT_HOST,
      port,
      fetch: handler.fetch,
    });
    console.error(
      `dome ask-server: serving vault ${vaultPath} on http://${server.hostname}:${server.port} (bearer-token auth)`,
    );
    options.onReady?.({ hostname: server.hostname ?? "", port: server.port ?? 0 });

    // Wait for shutdown: SIGINT/SIGTERM in production, the test-only abort
    // signal in tests. Listeners are removed on the way out so repeated
    // runAskServer invocations in one process (the test suite) don't accumulate.
    await new Promise<void>((done) => {
      const finish = (): void => {
        process.removeListener("SIGINT", finish);
        process.removeListener("SIGTERM", finish);
        done();
      };
      process.once("SIGINT", finish);
      process.once("SIGTERM", finish);
      if (options.signal !== undefined) {
        if (options.signal.aborted) {
          finish();
          return;
        }
        options.signal.addEventListener("abort", finish, { once: true });
      }
    });
    server.stop(true);
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`dome ask-server: failed: ${msg}`);
    return 1;
  }
}
