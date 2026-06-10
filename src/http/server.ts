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
//
// Boundary notes:
//
//   - Every route requires `Authorization: Bearer <token>` (constant-time
//     comparison). The server is meant to bind loopback or a private
//     (Tailscale-class) interface in the owner's trust domain — see the
//     spec's §"Trust domain". There is no anonymous route.
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
import { firstPartyViewNotFoundMessage } from "../surface/view";
import { openVault, type OpenVaultError, type Vault } from "../vault";

// ----- Constants ------------------------------------------------------------

const SERVER_SCHEMA = "dome.http/v1";
const DOCUMENT_SCHEMA = "dome.http.document/v1";
const QUESTIONS_SCHEMA = "dome.http.questions/v1";

const QUERY_VIEW_NAME = "dome.search.query";
const QUERY_VIEW_SCHEMA = "dome.search.query/v1";
const TODAY_VIEW_NAME = "dome.daily.today";
const TODAY_VIEW_SCHEMA = "dome.daily.today/v1";

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
  const enqueue = makeRouteMutex();

  const withVault = async (
    command: string,
    fn: (v: Vault) => Promise<Response>,
  ): Promise<Response> => {
    const opened = await openVault({ path: vault, bundlesRoot });
    if (!opened.ok) {
      return commandErrorResponse(command, openVaultErrorKind(opened.error));
    }
    try {
      return await fn(opened.value);
    } finally {
      await opened.value.close();
    }
  };

  const structuredView = async (input: {
    readonly route: string;
    readonly command: string;
    readonly args: unknown;
    readonly expectedViewName: string;
    readonly expectedSchema: string;
    readonly notFoundMessage: string;
  }): Promise<Response> =>
    withVault(input.route, async (v) => {
      const run = await v.runView(input.command, input.args);
      switch (run.kind) {
        case "detached-head":
          return errorResponse(409, "detached-head", `${input.route}: HEAD is detached. Check out a branch and retry.`);
        case "missing-adopted-ref":
          return errorResponse(409, "missing-adopted-ref", `${input.route}: vault has no adopted ref for branch '${run.branch}'. Run \`dome sync\` first to initialize.`);
        case "adopted-ref-unstable":
          return errorResponse(503, "adopted-ref-unstable", `${input.route}: adopted ref for branch '${run.branch}' changed repeatedly while rendering. Retry shortly.`);
        case "not-found":
          return errorResponse(404, "view-not-found", input.notFoundMessage);
        case "failed":
          return errorResponse(500, "processor-failed", `${input.route}: processor '${run.processorId}' finished with ${run.executionStatus}.`);
        case "ok": {
          const structured = run.structured;
          if (
            structured === null ||
            structured.name !== input.expectedViewName ||
            structured.schema !== input.expectedSchema
          ) {
            return errorResponse(500, "no-structured-result", `${input.route}: expected one '${input.expectedSchema}' structured view.`);
          }
          return jsonResponse(200, structured.data);
        }
      }
    });

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
          command: "query",
          args: Object.freeze({
            text,
            ...(category !== undefined ? { category } : {}),
            ...(type !== undefined ? { type } : {}),
            ...(limit !== null ? { limit } : {}),
          }),
          expectedViewName: QUERY_VIEW_NAME,
          expectedSchema: QUERY_VIEW_SCHEMA,
          notFoundMessage: firstPartyViewNotFoundMessage({
            commandLabel: "GET /query",
            bundleId: "dome.search",
            processorName: "query",
          }),
        });
      }

      case "GET /tasks": {
        const date = url.searchParams.get("date") ?? undefined;
        const limit = positiveInt(url.searchParams.get("limit"));
        return structuredView({
          route: "GET /tasks",
          command: "today",
          args: Object.freeze({
            ...(date !== undefined ? { date } : {}),
            ...(limit !== null ? { limit } : {}),
          }),
          expectedViewName: TODAY_VIEW_NAME,
          expectedSchema: TODAY_VIEW_SCHEMA,
          notFoundMessage: firstPartyViewNotFoundMessage({
            commandLabel: "GET /tasks",
            bundleId: "dome.daily",
            processorName: "today",
          }),
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
    if (!authorized(request, tokenDigest)) {
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

/** Serialize route work so at most one VaultRuntime is open at a time. */
function makeRouteMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
}

/** Constant-time bearer check: compare SHA-256 digests, never raw strings. */
function authorized(request: Request, tokenDigest: Buffer): boolean {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match === null || match[1] === undefined) return false;
  return timingSafeEqual(sha256(match[1]), tokenDigest);
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

function openVaultErrorKind(error: OpenVaultError): string {
  return error.kind === "runtime-open-failed" ? error.cause.kind : error.kind;
}

function positiveInt(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}
