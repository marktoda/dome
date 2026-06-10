// cli/commands/http: `dome http` — the HTTP read+capture surface.
//
// Per docs/wiki/specs/http-surface.md, this verb hosts the Dome HTTP
// protocol adapter for one vault. Same posture as `dome mcp`: a read/capture
// surface in the owner's trust domain — it runs no adoption loop and no
// scheduler (the daemon owns compilation). Binds loopback by default; point
// `--host` at a private (Tailscale-class) interface to reach it from a
// phone. Every request requires the bearer token (`--token` or
// `DOME_HTTP_TOKEN`).
//
// House-style notes (matches src/cli/commands/mcp.ts):
//   - `type X = { ... }` aliases, every field `readonly`.
//   - The handler returns the exit code; for `dome http` it returns only
//     when the listener stops (SIGINT/SIGTERM).

import { existsSync } from "node:fs";
import { join } from "node:path";

import { findGitRoot } from "../../git";
import { createDomeHttpServer } from "../../http/server";
import { resolveVaultPath } from "../../surface/resolve-vault";

const EX_USAGE = 64;

/** Default port: "dome" on a phone keypad. */
const DEFAULT_PORT = 3663;
const DEFAULT_HOST = "127.0.0.1";

export type RunHttpOptions = {
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly port?: string | number | undefined;
  readonly host?: string | undefined;
  readonly token?: string | undefined;
};

/**
 * Execute `dome http`. Serves the HTTP surface until the process receives
 * SIGINT/SIGTERM. Returns the exit code: 0 on clean shutdown; 64 (EX_USAGE)
 * on a missing token, malformed port, or uninitialized vault; 1 on listener
 * failure.
 */
export async function runHttp(options: RunHttpOptions = {}): Promise<number> {
  const vaultPath = resolveVaultPath(options.vault);

  const gitRoot = await findGitRoot(vaultPath);
  if (gitRoot === null || !existsSync(join(vaultPath, ".dome", "config.yaml"))) {
    console.error(
      `dome http: not an initialized Dome vault (missing ${
        gitRoot === null ? "git repository" : ".dome/config.yaml"
      }); run \`dome init\` first`,
    );
    return EX_USAGE;
  }

  const token = options.token ?? process.env["DOME_HTTP_TOKEN"] ?? "";
  if (token.trim().length === 0) {
    console.error(
      "dome http: a bearer token is required — pass --token <value> or set DOME_HTTP_TOKEN.",
    );
    return EX_USAGE;
  }

  const port = options.port === undefined ? DEFAULT_PORT : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`dome http: --port must be an integer in [0, 65535].`);
    return EX_USAGE;
  }

  try {
    const handler = createDomeHttpServer({
      vaultPath,
      token,
      ...(options.bundlesRoot !== undefined
        ? { bundlesRoot: options.bundlesRoot }
        : {}),
    });
    const server = Bun.serve({
      hostname: options.host ?? DEFAULT_HOST,
      port,
      fetch: handler.fetch,
    });
    console.error(
      `dome http: serving vault ${vaultPath} on http://${server.hostname}:${server.port} (bearer-token auth)`,
    );

    await new Promise<void>((done) => {
      process.once("SIGINT", () => done());
      process.once("SIGTERM", () => done());
    });
    server.stop(true);
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`dome http: failed: ${msg}`);
    return 1;
  }
}
