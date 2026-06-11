// http/server: the Dome HTTP surface — the read+capture protocol adapter.
//
// Per docs/wiki/specs/http-surface.md, this is a THIN adapter over the
// public `openVault` wrapper plus the protocol-neutral `src/surface/`
// collectors — the same posture as the MCP adapter (`src/mcp/server.ts`),
// lifted onto HTTP for callers that can't mount stdio: phones, shortcuts,
// scripts on other machines. Never imports `src/cli/` (pinned by
// tests/integration/surface-adapter-imports.test.ts).
//
//   POST /capture   → performCapture (source: "http")   dome.capture/v1
//   GET  /status    → buildStatusSnapshot               status snapshot
//   GET  /query     → vault.runView("query")            dome.search.query/v1
//   GET  /tasks     → vault.runView("today")            dome.daily.today/v1
//   GET  /doc       → vault.readDocument                dome.http.document/v1
//   GET  /questions → vault.listQuestions               dome.http.questions/v1
//   POST /resolve   → vault.resolve                     dome.answer/v1
//   GET  /today     → vault.runView("today") → HTML     cockpit page
//
// Boundary notes:
//
//   - Every route requires `Authorization: Bearer <token>` (constant-time
//     comparison). The server is meant to bind loopback or a private
//     (Tailscale-class) interface in the owner's trust domain — see the
//     spec's §"Trust domain". There is no anonymous route. `GET /today`
//     — and only that route — additionally accepts the same token as
//     `?token=` so a browser navigation can reach the cockpit (see
//     `queryTokenAuthorized`).
//   - `POST /capture` implements the remote-capture seam
//     ([[wiki/specs/capture]] §"The remote-capture seam"): it produces
//     exactly what `dome capture` produces — one raw file, one ordinary
//     human commit — and nothing else. `captureId` makes retries
//     idempotent.
//   - No engine control: no sync/serve/rebuild routes. The daemon owns
//     compilation; captures report `compile_pending` instead.
//   - No new dependencies: the handler is a plain `fetch` function for
//     `Bun.serve`. Nothing here is reachable from the static import graph
//     of `src/index.ts`.
//   - The route mutex serializes vault-opening work, so at most one
//     VaultRuntime is open at a time — the same one-CLI-invocation-at-a-
//     time posture as the MCP adapter.

import { createHash, timingSafeEqual } from "node:crypto";

import {
  ANSWER_SCHEMA,
  answerHandlersJson,
  questionRecordJson,
} from "../surface/answer";
import {
  captureJsonDocument,
  performCapture,
} from "../surface/capture";
import { COMMAND_ERROR_SCHEMA } from "../surface/command-error";
import { buildStatusSnapshot } from "../surface/status";
import {
  catalogViewProblemMessage,
  makeVaultMutex,
  openVaultErrorKind,
  runCatalogView,
  withVault as withVaultShared,
  type CatalogViewProblem,
} from "../surface/adapter";
import { FIRST_PARTY_VIEWS, type FirstPartyViewEntry } from "../surface/view-catalog";
import { renderTodayHtml } from "./today-html";
import type { Vault } from "../vault";

// ----- Constants ------------------------------------------------------------

const SERVER_SCHEMA = "dome.http/v1";
const DOCUMENT_SCHEMA = "dome.http.document/v1";
const QUESTIONS_SCHEMA = "dome.http.questions/v1";


// ----- Public types ---------------------------------------------------------

export type DomeHttpServerOptions = {
  readonly vaultPath: string;
  readonly bundlesRoot?: string | undefined;
  /** Bearer token every request must present. Must be non-empty. */
  readonly token: string;
};

export type DomeHttpServer = {
  readonly fetch: (request: Request) => Promise<Response>;
};

// ----- The server -------------------------------------------------------------

/**
 * Build the Dome HTTP fetch handler for one vault. The caller owns the
 * listener: `dome http` runs `Bun.serve({ fetch })` bound to loopback by
 * default; tests serve an ephemeral port.
 */
export function createDomeHttpServer(
  opts: DomeHttpServerOptions,
): DomeHttpServer {
  if (opts.token.trim().length === 0) {
    throw new Error("dome http: a non-empty bearer token is required");
  }
  const vault = opts.vaultPath;
  const bundlesRoot = opts.bundlesRoot;
  const tokenDigest = sha256(opts.token);
  const enqueue = makeVaultMutex();

  const withVault = async (
    command: string,
    fn: (v: Vault) => Promise<Response>,
  ): Promise<Response> => {
    const outcome = await withVaultShared({ path: vault, bundlesRoot }, fn);
    return outcome.kind === "open-failed"
      ? commandErrorResponse(command, openVaultErrorKind(outcome.error))
      : outcome.value;
  };

  const structuredView = async (input: {
    readonly route: string;
    readonly entry: FirstPartyViewEntry;
    readonly args: unknown;
  }): Promise<Response> => {
    const outcome = await withVaultShared({ path: vault, bundlesRoot }, (v) =>
      runCatalogView(v, input.entry, input.args),
    );
    if (outcome.kind === "open-failed") {
      return commandErrorResponse(
        input.route,
        openVaultErrorKind(outcome.error),
      );
    }
    const run = outcome.value;
    if (run.kind === "problem") {
      return errorResponse(
        viewProblemHttpStatus(run.problem),
        run.problem.kind,
        catalogViewProblemMessage(input.route, input.entry, run.problem),
      );
    }
    return jsonResponse(200, run.data);
  };

  const routes = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;

    switch (route) {
      case "GET /":
        return jsonResponse(200, { schema: SERVER_SCHEMA, server: "dome", vault });

      case "POST /capture": {
        const body = await jsonBody(request);
        if (body === null || typeof body.text !== "string" || body.text.trim().length === 0) {
          return errorResponse(400, "capture-usage", "POST /capture requires a JSON body with non-empty `text` (optional `title`, `captureId`).");
        }
        const outcome = await performCapture({
          text: body.text,
          ...(typeof body.title === "string" ? { title: body.title } : {}),
          ...(typeof body.captureId === "string" ? { captureId: body.captureId } : {}),
          vault,
          source: "http",
        });
        const doc = captureJsonDocument(outcome);
        if (outcome.kind === "error") {
          return jsonResponse(outcome.exitCode === 64 ? 400 : 500, doc);
        }
        return jsonResponse(200, doc);
      }

      case "GET /status": {
        const result = await buildStatusSnapshot({ vault, bundlesRoot });
        return result.kind === "runtime-open-failed"
          ? commandErrorResponse("status", result.errorKind)
          : jsonResponse(200, result.snapshot);
      }

      case "GET /query": {
        const text = url.searchParams.get("text")?.trim() ?? "";
        if (text.length === 0) {
          return errorResponse(400, "query-usage", "GET /query requires a non-empty `text` parameter.");
        }
        const limit = positiveInt(url.searchParams.get("limit"));
        const category = url.searchParams.get("category") ?? undefined;
        const type = url.searchParams.get("type") ?? undefined;
        return structuredView({
          route: "GET /query",
          entry: FIRST_PARTY_VIEWS.query,
          args: Object.freeze({
            text,
            ...(category !== undefined ? { category } : {}),
            ...(type !== undefined ? { type } : {}),
            ...(limit !== null ? { limit } : {}),
          }),
        });
      }

      case "GET /tasks": {
        const date = url.searchParams.get("date") ?? undefined;
        const limit = positiveInt(url.searchParams.get("limit"));
        return structuredView({
          route: "GET /tasks",
          entry: FIRST_PARTY_VIEWS.today,
          args: Object.freeze({
            ...(date !== undefined ? { date } : {}),
            ...(limit !== null ? { limit } : {}),
          }),
        });
      }

      case "GET /today": {
        const refresh = positiveInt(url.searchParams.get("refresh")) ?? 15;
        const outcome = await withVaultShared({ path: vault, bundlesRoot }, (v) =>
          runCatalogView(v, FIRST_PARTY_VIEWS.today, Object.freeze({})),
        );
        if (outcome.kind === "open-failed") {
          return commandErrorResponse("GET /today", openVaultErrorKind(outcome.error));
        }
        const run = outcome.value;
        if (run.kind === "problem") {
          return errorResponse(
            viewProblemHttpStatus(run.problem),
            run.problem.kind,
            catalogViewProblemMessage("GET /today", FIRST_PARTY_VIEWS.today, run.problem),
          );
        }
        return new Response(renderTodayHtml(run.data, { refreshSeconds: refresh }), {
          status: 200,
          // no-store: an authenticated page whose URL can carry ?token=, and
          // whose freshness contract is the meta-refresh — never cache it.
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      }

      case "GET /doc": {
        const path = url.searchParams.get("path")?.trim() ?? "";
        if (path.length === 0) {
          return errorResponse(400, "doc-usage", "GET /doc requires a non-empty `path` parameter.");
        }
        return withVault("GET /doc", async (v) => {
          const doc = await v.readDocument(path);
          if (doc === null) {
            return errorResponse(404, "document-not-found", `no document at '${path}' in adopted state.`);
          }
          return jsonResponse(200, {
            schema: DOCUMENT_SCHEMA,
            path: doc.path,
            commit: doc.commit,
            content: doc.content,
          });
        });
      }

      case "GET /questions":
        return withVault("GET /questions", async (v) => {
          const rows = await v.listQuestions({ resolved: false });
          return jsonResponse(200, {
            schema: QUESTIONS_SCHEMA,
            count: rows.length,
            questions: rows.map((row) => questionRecordJson(row)),
          });
        });

      case "POST /resolve": {
        const body = await jsonBody(request);
        const id = typeof body?.id === "number" && Number.isInteger(body.id) && body.id > 0
          ? body.id
          : null;
        const value = typeof body?.value === "string" ? body.value.trim() : "";
        if (id === null || value.length === 0) {
          return errorResponse(400, "resolve-usage", "POST /resolve requires a JSON body with a positive integer `id` and a non-empty `value`.");
        }
        return withVault("POST /resolve", async (v) => {
          const outcome = await v.resolve(id, value);
          switch (outcome.kind) {
            case "not-found":
              return jsonResponse(404, {
                schema: ANSWER_SCHEMA,
                status: "error",
                error: "question-not-found",
                message: `question ${id} was not found.`,
              });
            case "invalid-option":
              return jsonResponse(400, {
                schema: ANSWER_SCHEMA,
                status: "invalid-option",
                options: outcome.options,
                question: questionRecordJson(outcome.record),
              });
            case "answered":
            case "already-answered":
              return jsonResponse(200, {
                schema: ANSWER_SCHEMA,
                status: outcome.kind,
                question: questionRecordJson(outcome.record),
                handlers:
                  outcome.handlers === null
                    ? null
                    : answerHandlersJson(outcome.handlers),
              });
          }
        });
      }

      default:
        return errorResponse(404, "not-found", `no route for ${route}.`);
    }
  };

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (!authorized(request, tokenDigest) && !queryTokenAuthorized(request, url, tokenDigest)) {
      return errorResponse(401, "unauthorized", "missing or invalid bearer token.");
    }
    try {
      return await enqueue(() => routes(request));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return errorResponse(500, "internal", msg);
    }
  };

  return Object.freeze({ fetch: handle });
}

// ----- internals --------------------------------------------------------------

/** Constant-time bearer check: compare SHA-256 digests, never raw strings. */
function authorized(request: Request, tokenDigest: Buffer): boolean {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match === null || match[1] === undefined) return false;
  return timingSafeEqual(sha256(match[1]), tokenDigest);
}

/**
 * Browser-navigation escape hatch for the HTML cockpit ONLY: `GET /today`
 * may carry the bearer as `?token=` (browsers cannot set Authorization on a
 * plain navigation). Same digest, same constant-time comparison; every
 * other route stays header-only.
 */
function queryTokenAuthorized(
  request: Request,
  url: URL,
  tokenDigest: Buffer,
): boolean {
  if (request.method !== "GET" || url.pathname !== "/today") return false;
  const token = url.searchParams.get("token");
  if (token === null || token.length === 0) return false;
  return timingSafeEqual(sha256(token), tokenDigest);
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

async function jsonBody(
  request: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json();
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function jsonResponse(status: number, data: unknown): Response {
  return new Response(`${JSON.stringify(data, null, 2)}\n`, {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(
  status: number,
  error: string,
  message: string,
): Response {
  return jsonResponse(status, { status: "error", error, message });
}

/** The vault-open failure envelope — same shape as the CLI's. */
function commandErrorResponse(command: string, errorKind: string): Response {
  return jsonResponse(500, {
    schema: COMMAND_ERROR_SCHEMA,
    status: "error",
    command,
    error: errorKind,
    message:
      `dome ${command}: openVaultRuntime failed (${errorKind}). ` +
      "Run `dome init` to initialize the vault.",
  });
}

/** HTTP status semantics for a catalog-view problem. */
function viewProblemHttpStatus(problem: CatalogViewProblem): number {
  switch (problem.kind) {
    case "detached-head":
    case "missing-adopted-ref":
      return 409;
    case "adopted-ref-unstable":
      return 503;
    case "view-not-found":
      return 404;
    default:
      return 500;
  }
}

function positiveInt(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}
