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
import { createDomeHttpServer, DEFAULT_MAX_BODY_BYTES } from "../../http/server";
import { resolveVaultPath } from "../../surface/resolve-vault";
import { EX_USAGE } from "../exit-codes";

/** Default port: "dome" on a phone keypad. */
const DEFAULT_PORT = 3663;
const DEFAULT_HOST = "127.0.0.1";

export type RunHttpOptions = {
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly port?: string | number | undefined;
  readonly host?: string | undefined;
  readonly token?: string | undefined;
  readonly model?: string | undefined;
  /** Serve a built PWA from this directory (or env DOME_PWA_DIR). */
  readonly staticDir?: string | undefined;
  /** Grant the agent `author` (write) capability (or env DOME_ALLOW_WRITE). */
  readonly allowWrite?: boolean | undefined;
  readonly transcribeCmd?: string | undefined;
  readonly transcribeKey?: string | undefined;
  readonly transcribeUrl?: string | undefined;
  readonly transcribeModel?: string | undefined;
  /** Path to write one JSON line per agent-session turn (or env DOME_AGENT_LOG). */
  readonly agentLog?: string | undefined;
  /**
   * Test-only seam: aborting this signal stops the listener and resolves
   * runHttp with exit 0, exactly like SIGINT/SIGTERM. The CLI never passes
   * it — production shutdown stays signal-driven.
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

  const staticDir = options.staticDir ?? process.env["DOME_PWA_DIR"];
  const agentLogPath = options.agentLog ?? process.env["DOME_AGENT_LOG"];
  const allowWrite =
    options.allowWrite === true ||
    process.env["DOME_ALLOW_WRITE"] === "1" ||
    process.env["DOME_ALLOW_WRITE"] === "true";
  const transcribeCommand = (options.transcribeCmd ?? process.env["DOME_TRANSCRIBE_CMD"])
    ?.split(/\s+/)
    .filter(Boolean);
  const transcribeApiKey = options.transcribeKey ?? process.env["DOME_TRANSCRIBE_KEY"] ?? process.env["OPENAI_API_KEY"];
  const transcribeBaseUrl = options.transcribeUrl ?? process.env["DOME_TRANSCRIBE_URL"];
  const transcribeModel = options.transcribeModel ?? process.env["DOME_TRANSCRIBE_MODEL"];

  try {
    const handler = createDomeHttpServer({
      vaultPath,
      token,
      ...(options.bundlesRoot !== undefined
        ? { bundlesRoot: options.bundlesRoot }
        : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(staticDir !== undefined ? { staticDir } : {}),
      ...(allowWrite ? { allowWrite: true } : {}),
      ...(transcribeCommand !== undefined && transcribeCommand.length > 0 ? { transcribeCommand } : {}),
      ...(transcribeApiKey !== undefined && transcribeApiKey.length > 0 ? { transcribeApiKey } : {}),
      ...(transcribeBaseUrl !== undefined ? { transcribeBaseUrl } : {}),
      ...(transcribeModel !== undefined ? { transcribeModel } : {}),
      ...(agentLogPath !== undefined ? { agentLogPath } : {}),
    });
    const server = Bun.serve({
      hostname: options.host ?? DEFAULT_HOST,
      port,
      // Defense-in-depth backstop above the handler's own 1 MiB cap: the
      // handler answers 413 with the JSON error envelope (and is the only
      // layer that catches chunked bodies — Bun 1.2.x does not enforce
      // maxRequestBodySize on them); Bun's limit just hard-stops a
      // pathological declared content-length with a bare 413 should the
      // handler check ever regress.
      maxRequestBodySize: DEFAULT_MAX_BODY_BYTES * 2,
      fetch: handler.fetch,
    });
    console.error(
      `dome http: serving vault ${vaultPath} on http://${server.hostname}:${server.port} (bearer-token auth)`,
    );
    options.onReady?.({ hostname: server.hostname ?? "", port: server.port ?? 0 });

    // Wait for shutdown: SIGINT/SIGTERM in production, the test-only abort
    // signal in tests. Listeners are removed on the way out so repeated
    // runHttp invocations in one process (the test suite) don't accumulate.
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
    console.error(`dome http: failed: ${msg}`);
    return 1;
  }
}
