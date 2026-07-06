// src/http/server.ts
//
// The one Dome HTTP surface (`dome http`). A single capability-gated server
// over one vault + one mutex: read (query/doc/questions/status/tasks/today/
// recents), capture, resolve, the agent (`/agent` + `/agent/stream`),
// transcribe, and static PWA serving. `author` (write) is gated by --allow-write
// and provisioned in Phase 2.

import { createHash, timingSafeEqual } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep, join } from "node:path";

import { z } from "zod";
import {
  ANSWER_SCHEMA,
  answerHandlersJson,
  questionRecordJson,
} from "../surface/answer";
import { captureJsonDocument, performCapture } from "../surface/capture";
import { performSettle, settleResultJson } from "../surface/settle";
import {
  applyResultJson,
  collectProposals,
  performApply,
  performReject,
  proposalsJson,
  rejectResultJson,
} from "../surface/proposals";
import { buildRecents } from "../surface/recents";
import {
  catalogViewProblemMessage,
  dispatchView,
  makeVaultMutex,
  openVaultErrorKind,
  runtimeOpenFailureMessage,
  withVault as withVaultShared,
  type CatalogViewProblem,
  type ViewRenderer,
} from "../surface/adapter";
import { COMMAND_ERROR_SCHEMA } from "../surface/command-error";
import {
  FIRST_PARTY_VIEWS,
  type FirstPartyViewEntry,
} from "../surface/view-catalog";
import type { Vault } from "../vault";
import type { TextStreamPart, ToolSet } from "ai";
import { runAgent, runAgentStream, type AgentStream } from "../assistant/agent";
import type { AgentResult } from "../assistant/types";
import { buildStatusSnapshot } from "../surface/status";
import { renderTodayHtml } from "./today-html";
import { BASEL_BOOK_WOFF2_B64, BASEL_MEDIUM_WOFF2_B64 } from "./today-fonts";
import { grantedCapabilities, has, type Capability } from "../capabilities";
import { makeAgentLogSink, type AgentLogSink } from "./agent-log";

// ----- Constants ------------------------------------------------------------

const SCHEMA = "dome.ask/v1"; // stable wire schema for the agent answer + auth/usage error envelope; kept as "dome.ask/v1" (with the ask-* error codes) as the wire contract though the route was renamed /ask→/agent — renaming the wire id is a separate, client+docs-coordinated change.
const SERVER_SCHEMA = "dome.http/v1";
const DOCUMENT_SCHEMA = "dome.http.document/v1";
const QUESTIONS_SCHEMA = "dome.http.questions/v1";

/** Default request-body cap (1 MiB); `dome http` sets Bun's limit to 2× as a backstop. */
export const DEFAULT_MAX_BODY_BYTES = 1_048_576;

const EXT_BY_TYPE: Record<string, string> = {
  "audio/m4a": ".m4a", "audio/mp4": ".m4a", "audio/webm": ".webm",
  "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/mpeg": ".mp3", "audio/ogg": ".ogg",
};

/** The capability each route requires. Pings (GET / and /healthz) need none. */
const ROUTE_CAPABILITY: Readonly<Record<string, Capability>> = {
  "POST /agent": "converse",
  "POST /agent/stream": "converse",
  "POST /capture": "capture",
  "POST /resolve": "resolve",
  "POST /settle": "resolve",
  "GET /proposals": "read",
  "POST /apply": "resolve",
  "POST /reject": "resolve",
  "GET /tasks": "read",
  "GET /recents": "read",
  "GET /status": "read",
  "GET /query": "read",
  "GET /today": "read",
  "GET /doc": "read",
  "GET /questions": "read",
};

// ----- Public types ---------------------------------------------------------

export type AgentImpl = (question: string, signal: AbortSignal) => Promise<AgentResult>;

export type AgentStreamImpl = (question: string, signal: AbortSignal) => AgentStream;

export type DomeHttpServerOptions = {
  readonly vaultPath: string;
  readonly bundlesRoot?: string | undefined;
  /** Bearer token every request must present. Must be non-empty. */
  readonly token: string;
  readonly model?: string | undefined;
  /**
   * Grant the `author` capability (agent write tools). Default off
   * (read-only-safe). Provisioned in Phase 2; accepted now as the seam.
   */
  readonly allowWrite?: boolean | undefined;
  /**
   * Reject POST bodies larger than this with 413 `payload-too-large`
   * (default 1 MiB). Enforced on the declared `content-length` when present.
   */
  readonly maxBodyBytes?: number | undefined;
  /**
   * Milliseconds before a hung POST /agent is aborted and returns 504.
   * Defaults to 120_000 (2 minutes).
   */
  readonly timeoutMs?: number | undefined;
  /**
   * Inject a custom ask implementation (used by tests to avoid opening a real
   * vault). When omitted the default opens the vault and wires runAgent.
   */
  readonly agentImpl?: AgentImpl | undefined;
  /**
   * Inject a custom streaming ask implementation (used by tests to avoid a
   * model). When omitted the default opens the vault and wires runAgentStream.
   * Parallel to agentImpl.
   */
  readonly agentStreamImpl?: AgentStreamImpl | undefined;
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
   * API key for built-in cloud transcription via an OpenAI-compatible
   * POST /audio/transcriptions endpoint. Used when no transcribeCommand is set.
   * Audio is uploaded to the configured endpoint (it leaves the host).
   */
  readonly transcribeApiKey?: string | undefined;
  /** Base URL for cloud transcription (default https://api.openai.com/v1; e.g. https://api.groq.com/openai/v1). */
  readonly transcribeBaseUrl?: string | undefined;
  /** Cloud transcription model (default "whisper-1"; e.g. gpt-4o-mini-transcribe, whisper-large-v3-turbo). */
  readonly transcribeModel?: string | undefined;
  /**
   * Milliseconds before a hung POST /transcribe subprocess is killed and
   * returns 500 `transcribe-timeout`. Defaults to 120_000 (2 minutes).
   * Injectable so tests can set a short value (e.g. 50ms).
   */
  readonly transcribeTimeoutMs?: number | undefined;
  /**
   * Filesystem path to the agent request log file. When set, one JSON line is
   * appended per /agent (buffered) and /agent/stream request: granted
   * capabilities, authorEnabled, changes, stopReason, answer preview, duration,
   * and any error. When undefined (default), the sink is a no-op — zero cost.
   * Set via --agent-log or DOME_AGENT_LOG.
   */
  readonly agentLogPath?: string | undefined;
};

export type DomeHttpServer = { readonly fetch: (request: Request) => Promise<Response> };

// ----- Helpers (private) ----------------------------------------------------

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
 * Error envelope for the data routes (POST /capture, GET /tasks, POST /resolve,
 * GET /recents, GET /query, etc.). Does NOT carry a `schema` field — unlike
 * `errorResponse` above, which keeps `schema: "dome.ask/v1"` as the frozen
 * wire id the PWA depends on for the /agent response envelope. Two helpers
 * exist because /agent has a stable wire schema the PWA hardcodes; all other
 * routes use the schema-less data envelope.
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

/** The HTTP error-rendering seam: open failures + view problems → Responses. */
function httpViewRenderer<TPayload>(
  route: string,
  entry: FirstPartyViewEntry<TPayload>,
): ViewRenderer<Response> {
  return {
    openFailed: (error) =>
      commandErrorResponse(route, openVaultErrorKind(error)),
    problem: (problem) =>
      dataErrorResponse(
        viewProblemHttpStatus(problem),
        problem.kind,
        catalogViewProblemMessage(route, entry, problem),
      ),
  };
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

/** Serve the cockpit's two woff2 fonts (base64-inlined) unauthenticated, or null. */
function fontResponse(request: Request): Response | null {
  if (request.method !== "GET") return null;
  const pathname = new URL(request.url).pathname;
  const b64 =
    pathname === "/today/fonts/basel-book.woff2"
      ? BASEL_BOOK_WOFF2_B64
      : pathname === "/today/fonts/basel-medium.woff2"
        ? BASEL_MEDIUM_WOFF2_B64
        : null;
  if (b64 === null) return null;
  return new Response(Buffer.from(b64, "base64"), {
    status: 200,
    headers: { "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable" },
  });
}

/**
 * Browser-navigation escape hatch for the HTML cockpit ONLY: `GET /today` may
 * carry the bearer as `?token=` (a plain navigation cannot set Authorization).
 * Same digest, same constant-time comparison; every other route stays header-only.
 */
function queryTokenAuthorized(request: Request, url: URL, tokenDigest: Buffer): boolean {
  if (request.method !== "GET" || url.pathname !== "/today") return false;
  const token = url.searchParams.get("token");
  if (token === null || token.length === 0) return false;
  return timingSafeEqual(sha256(token), tokenDigest);
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
 * Build the unified Dome HTTP fetch handler. The caller owns the listener:
 * `dome http` runs `Bun.serve({ fetch })`; tests call `.fetch()` directly.
 */
export function createDomeHttpServer(opts: DomeHttpServerOptions): DomeHttpServer {
  if (opts.token.trim().length === 0) {
    throw new Error("createDomeHttpServer: token must be non-empty");
  }
  const tokenDigest = sha256(opts.token);
  const granted = grantedCapabilities({ allowWrite: opts.allowWrite });
  const maxBodyBytes = opts.maxBodyBytes ?? 1_048_576;
  const enqueue = makeVaultMutex();

  const timeoutMs = opts.timeoutMs ?? 120_000;
  const transcribeTimeoutMs = opts.transcribeTimeoutMs ?? 120_000;

  const agentLog: AgentLogSink = makeAgentLogSink(opts.agentLogPath);
  const authorEnabled = has(granted, "author");
  const capabilityList: string[] = [...granted].sort();

  // Vault-open wrapper for the data routes: runs `fn` against an open
  // VaultRuntime under the vault mutex, mapping an open failure to the
  // command-error envelope.
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

  // Default agent: open the vault, run the AI SDK agent loop over its tools.
  const defaultAgent: AgentImpl = async (question, signal) => {
    const outcome = await withVaultShared(
      { path: opts.vaultPath, bundlesRoot: opts.bundlesRoot },
      (vault) =>
        runAgent({
          vault,
          question,
          abortSignal: signal,
          ...(opts.model !== undefined ? { modelId: opts.model } : {}),
          ...(has(granted, "author") ? { allowWrite: true } : {}),
        }),
    );
    if (outcome.kind === "open-failed") {
      throw new Error(`vault open failed: ${openVaultErrorKind(outcome.error)}`);
    }
    return outcome.value;
  };

  const agent = opts.agentImpl ?? defaultAgent;

  // Default streaming agent: open the vault and keep it open for the whole
  // stream. withVault closes the vault when its callback resolves, but the
  // agent tools run lazily as the stream drains — so we hold the callback open
  // with a deferred promise that only resolves once fullStream is fully
  // consumed (or errors). The wrapped generator triggers that resolution in
  // its finally block, after which withVault closes the vault.
  const defaultAgentStream: AgentStreamImpl = (question, signal) => {
    let stream: AgentStream | undefined;
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
        stream = runAgentStream({
          vault,
          question,
          abortSignal: signal,
          ...(opts.model !== undefined ? { modelId: opts.model } : {}),
          ...(has(granted, "author") ? { allowWrite: true } : {}),
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
      get changes() {
        return stream?.changes ?? [];
      },
      get finished() {
        return (
          stream?.finished ?? Promise.resolve({ stopReason: "budget" as const })
        );
      },
    };
  };

  const agentStream = opts.agentStreamImpl ?? defaultAgentStream;

  // ----- POST /transcribe (runs authenticated but outside the vault mutex) -----
  //
  // /transcribe is runtime-free: it touches no vault — it either shells out to
  // a host whisper command (local, private) or uploads the audio to an
  // OpenAI-compatible cloud STT endpoint. Running it inside enqueue() would hold
  // the vault mutex for the call's duration — blocking /agent, /tasks, etc. — so
  // handle() dispatches it directly after auth, bypassing the mutex.
  const handleTranscribe = async (request: Request): Promise<Response> => {
    const cmd = opts.transcribeCommand;
    const hasCmd = cmd !== undefined && cmd.length > 0;
    const apiKey = opts.transcribeApiKey;
    const hasCloud = apiKey !== undefined && apiKey.length > 0;
    if (!hasCmd && !hasCloud) {
      return dataErrorResponse(501, "transcribe-unconfigured", "transcription is not configured on this server.");
    }
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBodyBytes) return dataErrorResponse(413, "payload-too-large", "audio too large.");
    const contentType = (request.headers.get("content-type") ?? "").split(";")[0]!.trim();
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength === 0) return dataErrorResponse(400, "transcribe-usage", "POST /transcribe requires an audio body.");
    if (bytes.byteLength > maxBodyBytes) return dataErrorResponse(413, "payload-too-large", "audio too large.");
    const ext = EXT_BY_TYPE[contentType] ?? ".audio";

    // Cloud path: when no local command is configured, upload the audio to an
    // OpenAI-compatible /audio/transcriptions endpoint (the easy, turnkey path).
    if (!hasCmd) {
      const baseUrl = (opts.transcribeBaseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
      const model = opts.transcribeModel ?? "whisper-1";
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: contentType || "audio/webm" }), `audio${ext}`);
      form.append("model", model);
      try {
        const res = await fetch(`${baseUrl}/audio/transcriptions`, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}` },
          body: form,
          signal: AbortSignal.timeout(transcribeTimeoutMs),
        });
        if (!res.ok) {
          return dataErrorResponse(502, "transcribe-failed", `transcription API ${res.status}: ${(await res.text()).slice(0, 300)}`);
        }
        const json = (await res.json()) as { text?: string };
        return jsonResponse(200, { schema: "dome.transcribe/v1", text: (json.text ?? "").trim() });
      } catch (e) {
        if (e instanceof Error && e.name === "TimeoutError") {
          return dataErrorResponse(500, "transcribe-timeout", `transcription exceeded ${transcribeTimeoutMs}ms.`);
        }
        return dataErrorResponse(500, "transcribe-failed", e instanceof Error ? e.message : String(e));
      }
    }

    // Local path: spawn the host command (audio never leaves the host).
    const dir = mkdtempSync(join(tmpdir(), "dome-transcribe-"));
    const audioPath = join(dir, `audio${ext}`);
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let proc: ReturnType<typeof Bun.spawn> | undefined;
    try {
      await Bun.write(audioPath, bytes);
      proc = Bun.spawn([...(cmd as ReadonlyArray<string>), audioPath], { stdout: "pipe", stderr: "pipe" });
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

    const need = ROUTE_CAPABILITY[route];
    if (need !== undefined && !has(granted, need)) {
      return dataErrorResponse(403, "capability-denied", `route ${route} requires the '${need}' capability.`);
    }

    if (route === "GET /" || route === "GET /healthz") {
      return jsonResponse(200, { schema: SERVER_SCHEMA, server: "dome", vault: opts.vaultPath, capabilities: [...granted].sort() });
    }

    if (route === "POST /agent") {
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
          "POST /agent requires a non-empty `question`.",
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
      const startedAt = Date.now();
      try {
        const result = await Promise.race([agent(question, controller.signal), timeoutPromise]);
        agentLog({
          ts: new Date().toISOString(),
          route: "/agent",
          question,
          capabilities: capabilityList,
          authorEnabled,
          changes: result.changes,
          stopReason: result.stopReason,
          answerPreview: result.answer.slice(0, 500),
          durationMs: Date.now() - startedAt,
          error: null,
        });
        return jsonResponse(200, {
          schema: SCHEMA,
          status: "ok",
          answer: result.answer,
          citations: result.citations,
          steps: result.steps,
          stopReason: result.stopReason,
          changes: result.changes,
        });
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        agentLog({
          ts: new Date().toISOString(),
          route: "/agent",
          question,
          capabilities: capabilityList,
          authorEnabled,
          changes: [],
          stopReason: null,
          answerPreview: null,
          durationMs: Date.now() - startedAt,
          error: errorMsg,
        });
        if (controller.signal.aborted) {
          return errorResponse(504, "ask-timeout", `ask exceeded ${timeoutMs}ms.`);
        }
        return errorResponse(
          500,
          "ask-failed",
          errorMsg,
        );
      } finally {
        clearTimeout(timer);
      }
    }

    if (route === "POST /agent/stream") {
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
          "POST /agent/stream requires a non-empty `question`.",
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
      const streamStartedAt = Date.now();

      const encoder = new TextEncoder();
      const sse = (payload: unknown): Uint8Array =>
        encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);

      const stream = agentStream(question, controller.signal);

      let signalDrained!: () => void;
      const drained = new Promise<void>((resolve) => {
        signalDrained = resolve;
      });
      void enqueue(() => drained);

      const sseBody = new ReadableStream<Uint8Array>({
        async start(ctrl) {
          let streamStopReason: string | null = null;
          let streamError: string | null = null;
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
                streamError = message;
              } else if (part.type === "abort") {
                // AI SDK signals an abort via a stream part — emit error and stop.
                const message = controller.signal.aborted
                  ? `ask exceeded ${timeoutMs}ms.`
                  : "aborted";
                ctrl.enqueue(sse({ type: "error", message }));
                streamError = message;
                abortedInLoop = true;
                break;
              }
            }
            if (abortedInLoop || controller.signal.aborted) {
              // Timed out or aborted after the loop: emit error, not done.
              if (!abortedInLoop) {
                const message = `ask exceeded ${timeoutMs}ms.`;
                ctrl.enqueue(sse({ type: "error", message }));
                streamError = message;
              }
            } else {
              const { stopReason } = await stream.finished;
              streamStopReason = stopReason;
              ctrl.enqueue(
                sse({ type: "done", citations: stream.citations, changes: stream.changes, stopReason }),
              );
            }
          } catch (e) {
            const message = controller.signal.aborted
              ? `ask exceeded ${timeoutMs}ms.`
              : e instanceof Error
                ? e.message
                : String(e);
            ctrl.enqueue(sse({ type: "error", message }));
            streamError = message;
          } finally {
            // Log the request outcome — the sink swallows errors so it cannot throw.
            agentLog({
              ts: new Date().toISOString(),
              route: "/agent/stream",
              question,
              capabilities: capabilityList,
              authorEnabled,
              changes: stream.changes,
              stopReason: streamStopReason,
              answerPreview: null, // stream text is not buffered server-side
              durationMs: Date.now() - streamStartedAt,
              error: streamError,
            });
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

    // ----- data routes -------------------------------------------------------

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
      // Lenient degrade: HTTP renders/serves the daily surface even on a
      // slightly-off payload, so it overrides the strict contract here and
      // enriches via `parseTodayView` downstream.
      const lenientToday = { ...FIRST_PARTY_VIEWS.today, payload: z.unknown() };
      const run = await dispatchView(
        { path: opts.vaultPath, bundlesRoot: opts.bundlesRoot },
        lenientToday,
        args,
        httpViewRenderer("GET /tasks", lenientToday),
      );
      return run.kind === "rendered" ? run.envelope : jsonResponse(200, run.data);
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

    if (route === "POST /settle") {
      const read = await jsonBody(request, maxBodyBytes);
      if (read.kind === "too-large") {
        return dataErrorResponse(413, "payload-too-large", `request body exceeds the ${maxBodyBytes}-byte limit.`);
      }
      const body = read.body;
      const blockId = typeof body?.blockId === "string" ? body.blockId.trim() : "";
      const disposition = typeof body?.disposition === "string" ? body.disposition : "";
      if (blockId.length === 0 || disposition.length === 0) {
        return dataErrorResponse(400, "settle-usage", "POST /settle requires a JSON body with non-empty `blockId` and `disposition` (optional `deferUntil`).");
      }
      // performSettle is runtime-free (locates the line + a human commit) —
      // no enqueue/withVault needed, same as POST /capture.
      const outcome = await performSettle(opts.vaultPath, {
        blockId,
        disposition: disposition as "close" | "defer" | "keep",
        ...(typeof body?.deferUntil === "string" ? { deferUntil: body.deferUntil } : {}),
      });
      const doc = settleResultJson(outcome);
      if (outcome.status === "not-found") return jsonResponse(404, doc);
      if (outcome.status === "invalid") return jsonResponse(400, doc);
      return jsonResponse(200, doc);
    }

    if (route === "GET /proposals") {
      // collectProposals is runtime-free (reads proposals.db directly) —
      // no enqueue/withVault needed, same as POST /capture and POST /settle.
      const all = url.searchParams.get("all") === "1";
      const doc = proposalsJson(await collectProposals(opts.vaultPath, { all }));
      return jsonResponse(200, doc);
    }

    if (route === "POST /apply") {
      const read = await jsonBody(request, maxBodyBytes);
      if (read.kind === "too-large") {
        return dataErrorResponse(413, "payload-too-large", `request body exceeds the ${maxBodyBytes}-byte limit.`);
      }
      const body = read.body;
      const id = typeof body?.id === "number" && Number.isInteger(body.id) && body.id > 0
        ? body.id
        : null;
      if (id === null) {
        return dataErrorResponse(400, "apply-usage", "POST /apply requires a JSON body with a positive integer `id`.");
      }
      // performApply is runtime-free (locates the proposal + a human commit) —
      // no enqueue/withVault needed, same as POST /settle.
      const outcome = await performApply(opts.vaultPath, id);
      const doc = applyResultJson(outcome);
      if (outcome.status === "not-found") return jsonResponse(404, doc);
      if (outcome.status === "not-pending" || outcome.status === "stale") return jsonResponse(409, doc);
      if (outcome.status === "invalid" || outcome.status === "unsupported") return jsonResponse(400, doc);
      return jsonResponse(200, doc);
    }

    if (route === "POST /reject") {
      const read = await jsonBody(request, maxBodyBytes);
      if (read.kind === "too-large") {
        return dataErrorResponse(413, "payload-too-large", `request body exceeds the ${maxBodyBytes}-byte limit.`);
      }
      const body = read.body;
      const id = typeof body?.id === "number" && Number.isInteger(body.id) && body.id > 0
        ? body.id
        : null;
      if (id === null) {
        return dataErrorResponse(400, "reject-usage", "POST /reject requires a JSON body with a positive integer `id` (optional `note`).");
      }
      const note = typeof body?.note === "string" ? body.note : undefined;
      // performReject is runtime-free (CAS-decides the row only) — no
      // enqueue/withVault needed, same as POST /apply.
      const outcome = await performReject(opts.vaultPath, id, note);
      const doc = rejectResultJson(outcome);
      if (outcome.status === "not-found") return jsonResponse(404, doc);
      if (outcome.status === "not-pending") return jsonResponse(409, doc);
      if (outcome.status === "invalid") return jsonResponse(400, doc);
      return jsonResponse(200, doc);
    }

    if (route === "GET /recents") {
      const limit = positiveInt(url.searchParams.get("limit")) ?? undefined;
      const entries = await buildRecents({
        vault: opts.vaultPath,
        ...(limit !== undefined ? { limit } : {}),
      });
      return jsonResponse(200, { schema: "dome.recents/v1", count: entries.length, entries });
    }

    // ----- read-only views (from the former `dome http`) ---------------------

    if (route === "GET /status") {
      const result = await buildStatusSnapshot({ vault: opts.vaultPath, bundlesRoot: opts.bundlesRoot });
      return result.kind === "runtime-open-failed"
        ? commandErrorResponse("status", result.errorKind)
        : jsonResponse(200, result.snapshot);
    }

    if (route === "GET /query") {
      const text = url.searchParams.get("text")?.trim() ?? "";
      if (text.length === 0) {
        return dataErrorResponse(400, "query-usage", "GET /query requires a non-empty `text` parameter.");
      }
      const limit = positiveInt(url.searchParams.get("limit"));
      const category = url.searchParams.get("category") ?? undefined;
      const type = url.searchParams.get("type") ?? undefined;
      const args = Object.freeze({
        text,
        ...(category !== undefined ? { category } : {}),
        ...(type !== undefined ? { type } : {}),
        ...(limit !== null ? { limit } : {}),
      });
      const run = await dispatchView(
        { path: opts.vaultPath, bundlesRoot: opts.bundlesRoot },
        FIRST_PARTY_VIEWS.query,
        args,
        httpViewRenderer("GET /query", FIRST_PARTY_VIEWS.query),
      );
      return run.kind === "rendered" ? run.envelope : jsonResponse(200, run.data);
    }

    if (route === "GET /today") {
      const refresh = positiveInt(url.searchParams.get("refresh")) ?? 15;
      // Lenient degrade (see GET /tasks): override the strict contract and
      // enrich via `parseTodayView` so the HTML surface always renders.
      const lenientToday = { ...FIRST_PARTY_VIEWS.today, payload: z.unknown() };
      const run = await dispatchView(
        { path: opts.vaultPath, bundlesRoot: opts.bundlesRoot },
        lenientToday,
        Object.freeze({}),
        httpViewRenderer("GET /today", lenientToday),
      );
      if (run.kind === "rendered") return run.envelope;
      return new Response(renderTodayHtml(run.data, { refreshSeconds: refresh }), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (route === "GET /doc") {
      const path = url.searchParams.get("path")?.trim() ?? "";
      if (path.length === 0) {
        return dataErrorResponse(400, "doc-usage", "GET /doc requires a non-empty `path` parameter.");
      }
      return withVault("GET /doc", async (v) => {
        const doc = await v.readDocument(path);
        if (doc === null) {
          return dataErrorResponse(404, "document-not-found", `no document at '${path}' in adopted state.`);
        }
        return jsonResponse(200, { schema: DOCUMENT_SCHEMA, path: doc.path, commit: doc.commit, content: doc.content });
      });
    }

    if (route === "GET /questions") {
      return withVault("GET /questions", async (v) => {
        const rows = await v.listQuestions({ resolved: false });
        return jsonResponse(200, { schema: QUESTIONS_SCHEMA, count: rows.length, questions: rows.map((row) => questionRecordJson(row)) });
      });
    }

    return dataErrorResponse(404, "not-found", `no route for ${route}.`);
  };

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    // Unauthenticated subresources: cockpit fonts, and (when configured) the PWA shell/assets.
    const font = fontResponse(request);
    if (font !== null) return font;
    if (request.method === "GET" && opts.staticDir !== undefined) {
      const served = await serveStatic(opts.staticDir, url.pathname);
      if (served !== null) return served; // unauthenticated, no mutex
    }
    // Header bearer for every route; the `?token=` escape is for GET /today only.
    if (!authorized(request, tokenDigest) && !queryTokenAuthorized(request, url, tokenDigest)) {
      return jsonResponse(401, {
        schema: SCHEMA,
        status: "error",
        error: "unauthorized",
        message: "missing or invalid bearer token.",
      });
    }
    // /transcribe runs authenticated but outside the vault mutex — it touches
    // no vault and can hold a subprocess for many seconds; letting it run
    // inside enqueue() would block /agent, /tasks, etc. for that entire time.
    if (request.method === "POST" && url.pathname === "/transcribe") {
      if (!has(granted, "capture")) {
        return dataErrorResponse(403, "capability-denied", "route POST /transcribe requires the 'capture' capability.");
      }
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
