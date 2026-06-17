// src/agent/server.ts
//
// The "ask my brain" HTTP surface: a single POST /ask route that authenticates
// a bearer token, validates the question body, runs the ask agent, and returns
// the answer + citations.  Mirrors src/http/server.ts auth + mutex idioms
// exactly; the vault/provider plumbing is identical — just a narrower route
// table.

import { createHash, timingSafeEqual } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep, join } from "node:path";
import {
  ANSWER_SCHEMA,
  answerHandlersJson,
  questionRecordJson,
} from "../surface/answer";
import { captureJsonDocument, performCapture } from "../surface/capture";
import { buildRecents } from "../surface/recents";
import {
  catalogViewProblemMessage,
  makeVaultMutex,
  openVaultErrorKind,
  runCatalogView,
  runtimeOpenFailureMessage,
  withVault as withVaultShared,
  type CatalogViewProblem,
} from "../surface/adapter";
import { COMMAND_ERROR_SCHEMA } from "../surface/command-error";
import { FIRST_PARTY_VIEWS } from "../surface/view-catalog";
import type { Vault } from "../vault";
import type { TextStreamPart, ToolSet } from "ai";
import { runAsk, runAskStream, type AskStream } from "./ask";
import type { AskResult } from "./types";

// ----- Constants ------------------------------------------------------------

const SCHEMA = "dome.ask/v1";

const EXT_BY_TYPE: Record<string, string> = {
  "audio/m4a": ".m4a", "audio/mp4": ".m4a", "audio/webm": ".webm",
  "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/mpeg": ".mp3", "audio/ogg": ".ogg",
};

// ----- Public types ---------------------------------------------------------

export type AskImpl = (question: string, signal: AbortSignal) => Promise<AskResult>;

export type AskStreamImpl = (question: string, signal: AbortSignal) => AskStream;

export type CreateAskServerOptions = {
  readonly vaultPath: string;
  readonly bundlesRoot?: string | undefined;
  /** Bearer token every request must present. Must be non-empty. */
  readonly token: string;
  readonly model?: string | undefined;
  /**
   * Reject POST bodies larger than this with 413 `payload-too-large`
   * (default 1 MiB). Enforced on the declared `content-length` when present.
   */
  readonly maxBodyBytes?: number | undefined;
  /**
   * Milliseconds before a hung POST /ask is aborted and returns 504.
   * Defaults to 120_000 (2 minutes).
   */
  readonly timeoutMs?: number | undefined;
  /**
   * Inject a custom ask implementation (used by tests to avoid opening a real
   * vault). When omitted the default opens the vault and wires runAsk.
   */
  readonly askImpl?: AskImpl | undefined;
  /**
   * Inject a custom streaming ask implementation (used by tests to avoid a
   * model). When omitted the default opens the vault and wires runAskStream.
   * Parallel to askImpl.
   */
  readonly askStreamImpl?: AskStreamImpl | undefined;
  /**
   * Filesystem path to the built PWA static assets directory. When set,
   * unauthenticated GET requests for "/" (app shell) and "/assets/*" are
   * served directly from this directory — bypassing auth entirely so the
   * browser can boot the PWA without a token.
   */
  readonly staticDir?: string | undefined;
  /**
   * Shell command to invoke for audio transcription (e.g. a local whisper
   * wrapper). The implementation appends the temp-file path as the last
   * argument. When undefined, POST /transcribe returns 501.
   */
  readonly transcribeCommand?: ReadonlyArray<string> | undefined;
  /**
   * Milliseconds before a hung POST /transcribe subprocess is killed and
   * returns 500 `transcribe-timeout`. Defaults to 120_000 (2 minutes).
   * Injectable so tests can set a short value (e.g. 50ms).
   */
  readonly transcribeTimeoutMs?: number | undefined;
};

export type AskServer = { readonly fetch: (request: Request) => Promise<Response> };

// ----- Helpers (private, mirrors src/http/server.ts) ------------------------

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

type JsonBodyRead =
  | { readonly kind: "ok"; readonly body: Record<string, unknown> | null }
  | { readonly kind: "too-large" };

/**
 * Read and parse a JSON request body without buffering more than `maxBytes`.
 * Two layers, both required:
 *
 *   1. A declared `content-length` over the cap answers `too-large` before
 *      reading anything.
 *   2. The body stream is read with a byte budget, so chunked or
 *      lying-content-length bodies are cut off at the cap too. (Bun's
 *      `maxRequestBodySize` does not enforce on chunked bodies as of
 *      Bun 1.2.x — this read is the real guarantee on every host.)
 *
 * Local copy; do NOT import from src/http/ — the agent server is self-contained.
 */
async function jsonBody(
  request: Request,
  maxBytes: number,
): Promise<JsonBodyRead> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { kind: "too-large" };
  }
  if (request.body === null) return { kind: "ok", body: null };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        return { kind: "too-large" };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return {
      kind: "ok",
      body:
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null,
    };
  } catch {
    return { kind: "ok", body: null };
  }
}

function jsonResponse(status: number, data: unknown): Response {
  return new Response(`${JSON.stringify(data, null, 2)}\n`, {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(status: number, error: string, message: string): Response {
  return jsonResponse(status, { schema: SCHEMA, status: "error", error, message });
}

/**
 * Error envelope for the PWA data routes (POST /capture, GET /tasks,
 * POST /resolve). These routes mirror `dome http` EXACTLY — including the
 * error shape, which does NOT carry a `schema` field (unlike the ask-specific
 * errorResponse above which adds `schema: "dome.ask/v1"`).
 */
function dataErrorResponse(status: number, error: string, message: string): Response {
  return jsonResponse(status, { status: "error", error, message });
}

/** The vault-open failure envelope — same shape as the http server's. */
function commandErrorResponse(command: string, errorKind: string): Response {
  return jsonResponse(500, {
    schema: COMMAND_ERROR_SCHEMA,
    status: "error",
    command,
    error: errorKind,
    message: runtimeOpenFailureMessage(`dome ${command}`, errorKind),
  });
}

/** HTTP status semantics for a catalog-view problem (mirrors src/http/server.ts). */
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

/** Constant-time bearer check: compare SHA-256 digests, never raw strings. */
function authorized(request: Request, tokenDigest: Buffer): boolean {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match === null || match[1] === undefined) return false;
  return timingSafeEqual(sha256(match[1]), tokenDigest);
}

// ----- Static asset serving --------------------------------------------------

/**
 * Serve the PWA app shell ("/" → index.html) or an asset ("/assets/...").
 * Returns null for any path that should fall through to the API routes.
 * Traversal attacks are rejected with 403 before the file is read.
 */
async function serveStatic(staticDir: string, pathname: string): Promise<Response | null> {
  // Only "/" (shell) and "/assets/..." are served. Everything else → null (fall through to API routing).
  const rel = pathname === "/" ? "index.html" : pathname.startsWith("/assets/") ? pathname.slice(1) : null;
  if (rel === null) return null;
  const root = resolve(staticDir);
  const full = resolve(join(root, rel));
  if (full !== root && !full.startsWith(root + sep)) {
    return new Response("forbidden", { status: 403 }); // traversal guard
  }
  const file = Bun.file(full);
  if (!(await file.exists())) return new Response("not found", { status: 404 });
  return new Response(file); // Bun sets content-type from extension
}

// ----- Server factory -------------------------------------------------------

/**
 * Build the ask-server fetch handler. The caller owns the listener:
 * `dome ask-server` runs `Bun.serve({ fetch })`; tests call `.fetch()` directly.
 */
export function createAskServer(opts: CreateAskServerOptions): AskServer {
  if (opts.token.trim().length === 0) {
    throw new Error("createAskServer: token must be non-empty");
  }
  const tokenDigest = sha256(opts.token);
  const maxBodyBytes = opts.maxBodyBytes ?? 1_048_576;
  const enqueue = makeVaultMutex();

  const timeoutMs = opts.timeoutMs ?? 120_000;
  const transcribeTimeoutMs = opts.transcribeTimeoutMs ?? 120_000;

  // Vault-open wrapper for the data routes (mirrors src/http/server.ts's
  // `withVault`): runs `fn` against an open VaultRuntime under the SAME mutex
  // the ask routes use, mapping an open failure to the command-error envelope.
  const withVault = async (
    command: string,
    fn: (v: Vault) => Promise<Response>,
  ): Promise<Response> => {
    const outcome = await withVaultShared(
      { path: opts.vaultPath, bundlesRoot: opts.bundlesRoot },
      fn,
    );
    return outcome.kind === "open-failed"
      ? commandErrorResponse(command, openVaultErrorKind(outcome.error))
      : outcome.value;
  };

  // Default ask: open the vault, run the AI SDK agent loop over its tools.
  const defaultAsk: AskImpl = async (question, signal) => {
    const outcome = await withVaultShared(
      { path: opts.vaultPath, bundlesRoot: opts.bundlesRoot },
      (vault) =>
        runAsk({
          vault,
          question,
          abortSignal: signal,
          ...(opts.model !== undefined ? { modelId: opts.model } : {}),
        }),
    );
    if (outcome.kind === "open-failed") {
      throw new Error(`vault open failed: ${openVaultErrorKind(outcome.error)}`);
    }
    return outcome.value;
  };

  const ask = opts.askImpl ?? defaultAsk;

  // Default streaming ask: open the vault and keep it open for the whole
  // stream. withVault closes the vault when its callback resolves, but the
  // ask tools run lazily as the stream drains — so we hold the callback open
  // with a deferred promise that only resolves once fullStream is fully
  // consumed (or errors). The wrapped generator triggers that resolution in
  // its finally block, after which withVault closes the vault.
  const defaultAskStream: AskStreamImpl = (question, signal) => {
    let stream: AskStream | undefined;
    let openError: Error | undefined;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: () => void;
    const opened = new Promise<void>((resolve) => {
      ready = resolve;
    });

    void withVaultShared(
      { path: opts.vaultPath, bundlesRoot: opts.bundlesRoot },
      async (vault) => {
        stream = runAskStream({
          vault,
          question,
          abortSignal: signal,
          ...(opts.model !== undefined ? { modelId: opts.model } : {}),
        });
        ready();
        // Hold the vault open until the route finishes draining the stream.
        await held;
      },
    ).then((outcome) => {
      if (outcome.kind === "open-failed") {
        openError = new Error(
          `vault open failed: ${openVaultErrorKind(outcome.error)}`,
        );
        ready();
      }
    });

    async function* drain(): AsyncIterable<TextStreamPart<ToolSet>> {
      await opened;
      if (openError !== undefined || stream === undefined) {
        release();
        throw openError ?? new Error("vault open failed");
      }
      try {
        for await (const part of stream.fullStream) {
          yield part;
        }
      } finally {
        release(); // let withVault close the vault
      }
    }

    return {
      fullStream: drain(),
      // Same array reference the tools push into; populated as the stream drains.
      get citations() {
        return stream?.citations ?? [];
      },
      get finished() {
        return (
          stream?.finished ?? Promise.resolve({ stopReason: "budget" as const })
        );
      },
    };
  };

  const askStream = opts.askStreamImpl ?? defaultAskStream;

  // ----- POST /transcribe (runs authenticated but outside the vault mutex) -----
  //
  // /transcribe is runtime-free: it touches no vault, only shells out to the
  // host whisper command. Running it inside enqueue() would hold the vault
  // mutex for the duration of the subprocess — blocking /ask, /tasks, etc.
  // Instead, handle() dispatches it directly after auth, bypassing the mutex.
  const handleTranscribe = async (request: Request): Promise<Response> => {
    if (opts.transcribeCommand === undefined || opts.transcribeCommand.length === 0) {
      return dataErrorResponse(501, "transcribe-unconfigured", "transcription is not configured on this server.");
    }
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBodyBytes) return dataErrorResponse(413, "payload-too-large", "audio too large.");
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength === 0) return dataErrorResponse(400, "transcribe-usage", "POST /transcribe requires an audio body.");
    if (bytes.byteLength > maxBodyBytes) return dataErrorResponse(413, "payload-too-large", "audio too large.");
    const ext = EXT_BY_TYPE[(request.headers.get("content-type") ?? "").split(";")[0]!.trim()] ?? ".audio";
    const dir = mkdtempSync(join(tmpdir(), "dome-transcribe-"));
    const audioPath = join(dir, `audio${ext}`);
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let proc: ReturnType<typeof Bun.spawn> | undefined;
    try {
      await Bun.write(audioPath, bytes);
      proc = Bun.spawn([...opts.transcribeCommand, audioPath], { stdout: "pipe", stderr: "pipe" });
      // Capture stream references immediately (they're typed as ReadableStream
      // when spawned with "pipe", but the let-binding's union type defeats
      // later narrowing after an await — so we pin them now).
      const stdout = proc.stdout as ReadableStream<Uint8Array>;
      const stderr = proc.stderr as ReadableStream<Uint8Array>;
      // Race the subprocess exit against the timeout. We must race BEFORE
      // reading stdout/stderr, because those streams stay open until the
      // process exits — reading them first would block indefinitely on a
      // hanging command and prevent the timeout from ever firing.
      const code = await Promise.race([
        proc.exited,
        new Promise<number>((_, reject) => {
          timeoutTimer = setTimeout(() => {
            proc!.kill();
            reject(new Error("__transcribe-timeout__"));
          }, transcribeTimeoutMs);
        }),
      ]);
      clearTimeout(timeoutTimer);
      timeoutTimer = undefined;
      // Process has exited — streams are now closed; safe to read output.
      const out = await new Response(stdout).text();
      if (code !== 0) {
        const err = await new Response(stderr).text();
        return dataErrorResponse(500, "transcribe-failed", `transcription command exited ${code}: ${err.slice(0, 500)}`);
      }
      return jsonResponse(200, { schema: "dome.transcribe/v1", text: out.trim() });
    } catch (e) {
      clearTimeout(timeoutTimer);
      if (e instanceof Error && e.message === "__transcribe-timeout__") {
        return dataErrorResponse(500, "transcribe-timeout", `transcription exceeded ${transcribeTimeoutMs}ms.`);
      }
      return dataErrorResponse(500, "transcribe-failed", e instanceof Error ? e.message : String(e));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  const routes = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;

    if (route === "GET /" || route === "GET /healthz") {
      return jsonResponse(200, { schema: "dome.ask-server/v1", server: "dome-ask" });
    }

    if (route === "POST /ask") {
      // Body size gate: bounded stream read (+ content-length fast-path inside).
      const read = await jsonBody(request, maxBodyBytes);
      if (read.kind === "too-large") {
        return errorResponse(413, "payload-too-large", `request body exceeds the ${maxBodyBytes}-byte limit.`);
      }
      if (read.body === null) {
        return errorResponse(400, "invalid-json", "request body is not valid JSON.");
      }

      const body = read.body;
      const question =
        typeof body.question === "string" ? body.question.trim() : "";
      if (question.length === 0) {
        return errorResponse(
          400,
          "ask-usage",
          "POST /ask requires a non-empty `question`.",
        );
      }

      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("__ask-timeout__"));
        }, timeoutMs);
      });
      try {
        const result = await Promise.race([ask(question, controller.signal), timeoutPromise]);
        return jsonResponse(200, {
          schema: SCHEMA,
          status: "ok",
          answer: result.answer,
          citations: result.citations,
          steps: result.steps,
          stopReason: result.stopReason,
        });
      } catch (e) {
        if (controller.signal.aborted) {
          return errorResponse(504, "ask-timeout", `ask exceeded ${timeoutMs}ms.`);
        }
        return errorResponse(
          500,
          "ask-failed",
          e instanceof Error ? e.message : String(e),
        );
      } finally {
        clearTimeout(timer);
      }
    }

    if (route === "POST /ask/stream") {
      const read = await jsonBody(request, maxBodyBytes);
      if (read.kind === "too-large") {
        return errorResponse(413, "payload-too-large", `request body exceeds the ${maxBodyBytes}-byte limit.`);
      }
      if (read.body === null) {
        return errorResponse(400, "invalid-json", "request body is not valid JSON.");
      }

      const body = read.body;
      const question =
        typeof body.question === "string" ? body.question.trim() : "";
      if (question.length === 0) {
        return errorResponse(
          400,
          "ask-usage",
          "POST /ask/stream requires a non-empty `question`.",
        );
      }

      // Headers are flushed as soon as we return the Response, so an error or
      // timeout AFTER that point cannot change the status — it surfaces as an
      // SSE `error` event then closes. The timeout's controller signal feeds
      // the stream's abortSignal; on abort the underlying stream ends (or
      // emits an error part), which we forward and then close.
      //
      // Mutex: routes() runs inside the vault mutex, but the SSE body drains
      // AFTER we return the Response (and the route resolves). To keep the
      // one-VaultRuntime-at-a-time posture, we hold the mutex slot until the
      // drain finishes by acquiring a nested mutex turn that resolves only on
      // `drained` — `handle` already serialized us in, and this nested turn
      // keeps the NEXT request queued until this stream closes.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const encoder = new TextEncoder();
      const sse = (payload: unknown): Uint8Array =>
        encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);

      const stream = askStream(question, controller.signal);

      let signalDrained!: () => void;
      const drained = new Promise<void>((resolve) => {
        signalDrained = resolve;
      });
      void enqueue(() => drained);

      const sseBody = new ReadableStream<Uint8Array>({
        async start(ctrl) {
          try {
            let abortedInLoop = false;
            for await (const part of stream.fullStream) {
              if (part.type === "text-delta") {
                ctrl.enqueue(sse({ type: "text", text: part.text }));
              } else if (part.type === "error") {
                const message =
                  part.error instanceof Error
                    ? part.error.message
                    : String(part.error);
                ctrl.enqueue(sse({ type: "error", message }));
              } else if (part.type === "abort") {
                // AI SDK signals an abort via a stream part — emit error and stop.
                const message = controller.signal.aborted
                  ? `ask exceeded ${timeoutMs}ms.`
                  : "aborted";
                ctrl.enqueue(sse({ type: "error", message }));
                abortedInLoop = true;
                break;
              }
            }
            if (abortedInLoop || controller.signal.aborted) {
              // Timed out or aborted after the loop: emit error, not done.
              if (!abortedInLoop) {
                ctrl.enqueue(sse({ type: "error", message: `ask exceeded ${timeoutMs}ms.` }));
              }
            } else {
              const { stopReason } = await stream.finished;
              ctrl.enqueue(
                sse({ type: "done", citations: stream.citations, stopReason }),
              );
            }
          } catch (e) {
            const message = controller.signal.aborted
              ? `ask exceeded ${timeoutMs}ms.`
              : e instanceof Error
                ? e.message
                : String(e);
            ctrl.enqueue(sse({ type: "error", message }));
          } finally {
            clearTimeout(timer);
            signalDrained();
            ctrl.close();
          }
        },
      });

      return new Response(sseBody, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
        },
      });
    }

    // ----- PWA data routes ---------------------------------------------------
    //
    // These mirror src/http/server.ts's `POST /capture`, `GET /tasks`, and
    // `POST /resolve` EXACTLY — same parsing, same JSON shapes, same status
    // codes — reusing the same shared `src/surface/` collectors under THIS
    // server's single mutex (no delegation to `dome http`, which owns its own
    // mutex). The PWA gets identical contracts whichever server it hits.

    if (route === "POST /capture") {
      const read = await jsonBody(request, maxBodyBytes);
      if (read.kind === "too-large") {
        return dataErrorResponse(413, "payload-too-large", `request body exceeds the ${maxBodyBytes}-byte limit.`);
      }
      const body = read.body;
      if (body === null || typeof body.text !== "string" || body.text.trim().length === 0) {
        return dataErrorResponse(400, "capture-usage", "POST /capture requires a JSON body with non-empty `text` (optional `title`, `captureId`).");
      }
      // performCapture is runtime-free (writes a raw file + a human commit) —
      // no enqueue/withVault needed, same as the http server.
      const outcome = await performCapture({
        text: body.text,
        ...(typeof body.title === "string" ? { title: body.title } : {}),
        ...(typeof body.captureId === "string" ? { captureId: body.captureId } : {}),
        vault: opts.vaultPath,
        source: "http",
      });
      const doc = captureJsonDocument(outcome);
      if (outcome.kind === "error") {
        return jsonResponse(outcome.exitCode === 64 ? 400 : 500, doc);
      }
      return jsonResponse(200, doc);
    }

    if (route === "GET /tasks") {
      const date = url.searchParams.get("date") ?? undefined;
      const limit = positiveInt(url.searchParams.get("limit"));
      const args = Object.freeze({
        ...(date !== undefined ? { date } : {}),
        ...(limit !== null ? { limit } : {}),
      });
      const outcome = await withVaultShared(
        { path: opts.vaultPath, bundlesRoot: opts.bundlesRoot },
        (v) => runCatalogView(v, FIRST_PARTY_VIEWS.today, args),
      );
      if (outcome.kind === "open-failed") {
        return commandErrorResponse("GET /tasks", openVaultErrorKind(outcome.error));
      }
      const run = outcome.value;
      if (run.kind === "problem") {
        return dataErrorResponse(
          viewProblemHttpStatus(run.problem),
          run.problem.kind,
          catalogViewProblemMessage("GET /tasks", FIRST_PARTY_VIEWS.today, run.problem),
        );
      }
      return jsonResponse(200, run.data);
    }

    if (route === "POST /resolve") {
      const read = await jsonBody(request, maxBodyBytes);
      if (read.kind === "too-large") {
        return dataErrorResponse(413, "payload-too-large", `request body exceeds the ${maxBodyBytes}-byte limit.`);
      }
      const body = read.body;
      const id = typeof body?.id === "number" && Number.isInteger(body.id) && body.id > 0
        ? body.id
        : null;
      const value = typeof body?.value === "string" ? body.value.trim() : "";
      if (id === null || value.length === 0) {
        return dataErrorResponse(400, "resolve-usage", "POST /resolve requires a JSON body with a positive integer `id` and a non-empty `value`.");
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

    if (route === "GET /recents") {
      const limit = positiveInt(url.searchParams.get("limit")) ?? undefined;
      const entries = await buildRecents({
        vault: opts.vaultPath,
        ...(limit !== undefined ? { limit } : {}),
      });
      return jsonResponse(200, { schema: "dome.recents/v1", count: entries.length, entries });
    }

    return dataErrorResponse(404, "not-found", `no route for ${route}.`);
  };

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && opts.staticDir !== undefined) {
      const served = await serveStatic(opts.staticDir, url.pathname);
      if (served !== null) return served; // unauthenticated, no mutex
    }
    if (!authorized(request, tokenDigest)) {
      return jsonResponse(401, {
        schema: SCHEMA,
        status: "error",
        error: "unauthorized",
        message: "missing or invalid bearer token.",
      });
    }
    // /transcribe runs authenticated but outside the vault mutex — it touches
    // no vault and can hold a subprocess for many seconds; letting it run
    // inside enqueue() would block /ask, /tasks, etc. for that entire time.
    if (request.method === "POST" && url.pathname === "/transcribe") {
      return handleTranscribe(request);
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
