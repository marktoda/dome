// src/http/server.ts
//
// The one Dome HTTP surface (`dome http`). A single capability-gated server
// over one vault + injected Product Host admission (or one compatibility mutex): read (query/doc/questions/status/plugin views/
// tasks/today/recents), capture, resolve, session-oriented foreground agents,
// transcribe, and static PWA serving. Compatibility callers use a bearer;
// P1 browsers may exchange a loopback pairing code for an HttpOnly cookie.
// `author` (write) is gated by --allow-write and provisioned in Phase 2.

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { lstat, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep, join } from "node:path";

import { z } from "zod";
import {
  AGENT_STREAM_SCHEMA,
  encodeAgentStreamEvent,
} from "../../contracts/agent-stream";
import type { SourceDocumentResult } from "../../contracts/source-document";
import { SourceRefSchema, type SourceRef } from "../core/source-ref";
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
  dispatchViewOnVault,
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
import { runAgentStream, type AgentStream } from "../assistant/agent";
import {
  createAgentRuntime,
  type AgentRun,
  type AgentRuntime,
  type AgentRuntimeFailure,
  type AgentSession,
} from "../assistant/runtime";
import type { AgentMessage } from "../assistant/types";
import { buildStatusSnapshot } from "../surface/status";
import { collectViews } from "../surface/views";
import { runInstalledView, viewRunStatus } from "../surface/run-view";
import { renderTodayHtml } from "./today-html";
import { BASEL_BOOK_WOFF2_B64, BASEL_MEDIUM_WOFF2_B64 } from "./today-fonts";
import { grantedCapabilities, has, type Capability } from "../capabilities";
import { makeAgentLogSink, type AgentLogSink } from "./agent-log";
import { drainAgentWork, type AgentWorkAgent } from "../agent-work/attempt";
import { createBuiltInAgentWorkAgent } from "../assistant/agent-work";
import {
  createLoopbackPairing,
  type LoopbackPairing,
} from "./loopback-pairing";
import type { DeviceAuthority } from "../device-authority/device-authority";
import {
  authenticateDeviceRequest,
  exchangeDevicePairing,
  hardenDeviceResponse,
  type DeviceRequestContext,
} from "./device-request-auth";
import {
  ProductOperationCancelledError,
  ProductOperationQueueFullError,
  ProductOperationSchedulerClosedError,
  type ProductOperationClass,
  type ProductOperationScheduler,
} from "../product-host/operation-scheduler";
import { readSourceDocument } from "../source-document/source-document";
import type {
  FinishRequestReceiptInput,
  HttpRequestReceiptRecorder,
  RequestReceiptOperation,
  RequestReceiptOperationClass,
} from "../request-receipts/request-receipts";
import type {
  AssistantMutationExecutor,
  AuthenticatedMutationActor,
} from "../request-receipts/assistant-mutation-executor";

// ----- Constants ------------------------------------------------------------

const SERVER_SCHEMA = "dome.http/v1";
const DOCUMENT_SCHEMA = "dome.http.document/v1";
const QUESTIONS_SCHEMA = "dome.http.questions/v1";
const AGENT_SESSION_SCHEMA = "dome.agent-session/v1";

/** Default request-body cap (1 MiB); `dome http` sets Bun's limit to 2× as a backstop. */
export const DEFAULT_MAX_BODY_BYTES = 1_048_576;

const EXT_BY_TYPE: Record<string, string> = {
  "audio/m4a": ".m4a", "audio/mp4": ".m4a", "audio/webm": ".webm",
  "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/mpeg": ".mp3", "audio/ogg": ".ogg",
};

/** The capability each route requires. Pings (GET / and /healthz) need none. */
const ROUTE_CAPABILITY: Readonly<Record<string, Capability>> = {
  "POST /sessions": "converse",
  "POST /capture": "capture",
  "POST /resolve": "resolve",
  "POST /settle": "resolve",
  "GET /proposals": "read",
  "GET /attention": "read",
  "GET /agent-work": "read",
  "POST /agent-work/complete": "resolve",
  "POST /agent-work/drain": "converse",
  "POST /apply": "resolve",
  "POST /reject": "resolve",
  "GET /tasks": "read",
  "GET /recents": "read",
  "GET /status": "read",
  "GET /query": "read",
  "GET /today": "read",
  "GET /doc": "read",
  "GET /source": "read",
  "GET /questions": "read",
  "GET /views": "read",
};

// ----- Public types ---------------------------------------------------------

export type DomeHttpServerOptions = {
  readonly vaultPath: string;
  /** Long-lived Product Host handle. When present, routes never reopen it. */
  readonly vault?: Vault | undefined;
  readonly bundlesRoot?: string | undefined;
  /** Compatibility bearer. Omitted only when durable device auth is supplied. */
  readonly token?: string | undefined;
  /** Durable Product Host auth. When present, compatibility auth is disabled. */
  readonly deviceAuth?: {
    readonly authority: DeviceAuthority;
    readonly allowedOrigins: () => ReadonlyArray<string>;
  } | undefined;
  /**
   * Optional P1 loopback-only browser pairing. The CLI refuses this option on
   * non-loopback binds. Sessions are process-local; P3 owns durable devices.
   */
  readonly loopbackPairing?: {
    readonly code: string;
    readonly sessionTtlMs?: number;
  } | undefined;
  /** Authenticated Product Host readiness document. */
  readonly readiness?: ((client?: DeviceRequestContext) => Promise<unknown>) | undefined;
  /** Product Host admission. Compatibility servers retain their legacy mutex. */
  readonly operationScheduler?: Pick<ProductOperationScheduler, "run"> | undefined;
  /** Durable Product Host mutation audit; absent in compatibility mode. */
  readonly requestReceiptRecorder?: HttpRequestReceiptRecorder | undefined;
  readonly assistantMutationExecutor?: AssistantMutationExecutor | undefined;
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
   * Milliseconds before a hung agent session turn is aborted.
   * Defaults to 120_000 (2 minutes).
   */
  readonly timeoutMs?: number | undefined;
  /**
   * Replace the foreground-agent implementation while preserving the HTTP
   * session protocol. When omitted, the built-in AI SDK adapter is used.
   */
  readonly agentRuntime?: AgentRuntime | undefined;
  /**
   * Replace the model used by POST /agent-work/drain. The factory receives
   * the call-scoped Vault handle; omitted uses the built-in AI SDK adapter.
   */
  readonly agentWorkAgent?: ((vault: Vault) => AgentWorkAgent) | undefined;
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
   * appended per agent-session turn: granted
   * capabilities, authorEnabled, changes, stopReason, answer preview, duration,
   * and any error. When undefined (default), the sink is a no-op — zero cost.
   * Set via --agent-log or DOME_AGENT_LOG.
   */
  readonly agentLogPath?: string | undefined;
};

export type DomeHttpServer = {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly close: () => Promise<void>;
};

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

/**
 * Error envelope shared by session and deterministic data routes.
 */
function dataErrorResponse(status: number, error: string, message: string): Response {
  return jsonResponse(status, { status: "error", error, message });
}

function withReceiptId(response: Response, operationId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("x-dome-receipt-id", operationId);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function mutationOutcomeUnknownResponse(requestId: string): Response {
  return jsonResponse(500, {
    status: "error",
    error: "mutation-outcome-unknown",
    message: `The mutation outcome is unknown and must not be replayed. Reference request ${requestId}.`,
    retryable: false,
  });
}

function sourceDocumentHttpStatus(result: SourceDocumentResult): number {
  switch (result.status) {
    case "ok": return 200;
    case "invalid-path":
    case "invalid-commit": return 400;
    case "not-adopted":
    case "not-found": return 404;
    case "too-large": return 413;
    case "unavailable": return 503;
  }
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

const PWA_INSTALL_ASSETS = new Set([
  "apple-touch-icon-180x180.png",
  "dome.svg",
  "favicon.ico",
  "maskable-icon-512x512.png",
  "pwa-64x64.png",
  "pwa-192x192.png",
  "pwa-512x512.png",
]);

/**
 * Serve only the closed VitePWA GenerateSW output shape. Unknown root files,
 * nested assets, and API paths fall through to authenticated routing.
 */
async function serveStatic(staticDir: string, pathname: string): Promise<Response | null> {
  const rel = staticPath(pathname);
  if (rel === null) return null;
  const root = resolve(staticDir);
  const full = resolve(join(root, rel));
  if (full !== root && !full.startsWith(root + sep)) {
    return new Response("forbidden", { status: 403 }); // traversal guard
  }
  try {
    const [rootInfo, fileInfo, realRoot, realFile] = await Promise.all([
      lstat(root), lstat(full), realpath(root), realpath(full),
    ]);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() ||
      !fileInfo.isFile() || fileInfo.isSymbolicLink() ||
      (realFile !== realRoot && !realFile.startsWith(`${realRoot}${sep}`))) {
      return new Response("not found", { status: 404 });
    }
  } catch {
    return new Response("not found", { status: 404 });
  }
  const file = Bun.file(full);
  const headers = new Headers({
    "cache-control": pathname === "/" || pathname === "/index.html" || pathname === "/manifest.webmanifest" || pathname === "/sw.js" || PWA_INSTALL_ASSETS.has(rel)
      ? "no-cache"
      : "public, max-age=31536000, immutable",
  });
  if (pathname === "/sw.js") headers.set("service-worker-allowed", "/");
  return new Response(file, { headers }); // Bun supplies content-type from Blob metadata.
}

function staticPath(pathname: string): string | null {
  if (pathname === "/" || pathname === "/index.html") return "index.html";
  if (pathname === "/manifest.webmanifest") return "manifest.webmanifest";
  if (pathname === "/sw.js") return "sw.js";
  if (PWA_INSTALL_ASSETS.has(pathname.slice(1))) return pathname.slice(1);
  if (/^\/workbox-[a-f0-9]{8}\.js$/.test(pathname)) return pathname.slice(1);
  const asset = /^\/assets\/([^/]+)$/.exec(pathname)?.[1];
  if (asset !== undefined && /^[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{6,}\.(?:js|css)$/.test(asset)) {
    return `assets/${asset}`;
  }
  return null;
}

// ----- Server factory -------------------------------------------------------

/**
 * Build the unified Dome HTTP fetch handler. The caller owns the listener:
 * `dome http` runs `Bun.serve({ fetch })`; tests call `.fetch()` directly.
 */
export function createDomeHttpServer(opts: DomeHttpServerOptions): DomeHttpServer {
  const deviceMode = opts.deviceAuth !== undefined;
  if (!deviceMode && (opts.token ?? "").trim().length === 0) {
    throw new Error("createDomeHttpServer: token must be non-empty");
  }
  if (deviceMode && opts.loopbackPairing !== undefined) {
    throw new Error("createDomeHttpServer: durable device auth cannot use loopback pairing");
  }
  if (deviceMode && opts.token !== undefined) {
    throw new Error("createDomeHttpServer: durable device auth cannot use a compatibility token");
  }
  const tokenDigest = deviceMode ? null : sha256(opts.token!);
  const pairing: LoopbackPairing | null = deviceMode || opts.loopbackPairing === undefined
    ? null
    : createLoopbackPairing(opts.loopbackPairing);
  const granted = grantedCapabilities({ allowWrite: opts.allowWrite });
  const maxBodyBytes = opts.maxBodyBytes ?? 1_048_576;
  const enqueue = makeVaultMutex();

  const timeoutMs = opts.timeoutMs ?? 120_000;
  const transcribeTimeoutMs = opts.transcribeTimeoutMs ?? 120_000;

  const agentLog: AgentLogSink = makeAgentLogSink(opts.agentLogPath);

  // Vault-open wrapper for the data routes: runs `fn` against an open
  // VaultRuntime under the vault mutex, mapping an open failure to the
  // command-error envelope.
  const withVault = async (
    command: string,
    fn: (v: Vault) => Promise<Response>,
  ): Promise<Response> => {
    if (opts.vault !== undefined) {
      try {
        return await fn(opts.vault);
      } catch {
        return commandErrorResponse(command, "runtime-operation-failed");
      }
    }
    const outcome = await withVaultShared(
      { path: opts.vaultPath, bundlesRoot: opts.bundlesRoot },
      fn,
    );
    return outcome.kind === "open-failed"
      ? commandErrorResponse(command, openVaultErrorKind(outcome.error))
      : outcome.value;
  };

  const dispatchHttpView = async <TPayload>(
    entry: FirstPartyViewEntry<TPayload>,
    args: unknown,
    renderer: ViewRenderer<Response>,
  ) => opts.vault === undefined
    ? dispatchView(
        { path: opts.vaultPath, bundlesRoot: opts.bundlesRoot },
        entry,
        args,
        renderer,
      )
    : dispatchViewOnVault(opts.vault, entry, args, renderer);

  // Default streaming agent: open the vault and keep it open for the whole
  // stream. withVault closes the vault when its callback resolves, but the
  // agent tools run lazily as the stream drains — so we hold the callback open
  // with a deferred promise that only resolves once fullStream is fully
  // consumed (or errors). The wrapped generator triggers that resolution in
  const defaultAgentStreamTurn = (
    question: string,
    history: ReadonlyArray<AgentMessage>,
    signal: AbortSignal,
    turnCapabilities: ReadonlySet<Capability>,
    mutationActor?: AuthenticatedMutationActor,
  ): AgentStream => {
    if (opts.vault !== undefined) {
      return runAgentStream({
        vault: opts.vault,
        question,
        history,
        abortSignal: signal,
        capabilities: turnCapabilities,
        ...(mutationActor !== undefined ? { mutationActor } : {}),
        ...(opts.assistantMutationExecutor !== undefined ? { mutationExecutor: opts.assistantMutationExecutor } : {}),
        ...(opts.model !== undefined ? { modelId: opts.model } : {}),
      });
    }
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
          history,
          abortSignal: signal,
          // Same capability plumbing as defaultAgent above.
          capabilities: turnCapabilities,
          ...(mutationActor !== undefined ? { mutationActor } : {}),
          ...(opts.assistantMutationExecutor !== undefined ? { mutationExecutor: opts.assistantMutationExecutor } : {}),
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

    async function* drain() {
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

  const agentRuntime = opts.agentRuntime ?? createAgentRuntime({
    runTurn: ({ question, history, signal, sessionContext, mutationActor }): AgentRun => {
      const turnCapabilities = sessionContext?.capabilities ?? granted;
      const stream = defaultAgentStreamTurn(
        question,
        history,
        signal ?? new AbortController().signal,
        turnCapabilities,
        mutationActor,
      );
      return {
        text: (async function* () {
          for await (const part of stream.fullStream) {
            if (part.type === "text-delta") yield part.text;
          }
        })(),
        finished: stream.finished.then((finished) => ({
          citations: stream.citations,
          changes: stream.changes,
          stopReason: finished.stopReason,
        })),
      };
    },
  });
  const activeTurns = new Set<{
    readonly controller: AbortController;
    readonly drained: Promise<void>;
  }>();

  type RecordedMutation = Readonly<{
    response: Response;
    terminal: FinishRequestReceiptInput;
  }>;
  const recordMutation = async (
    client: DeviceRequestContext | undefined,
    operation: RequestReceiptOperation,
    operationClass: RequestReceiptOperationClass,
    mutate: () => Promise<RecordedMutation>,
  ): Promise<Response> => {
    if (client === undefined || opts.requestReceiptRecorder === undefined) {
      return (await mutate()).response;
    }
    let lease;
    try {
      lease = opts.requestReceiptRecorder.admit({
        requestId: client.requestId,
        actorId: client.actorId,
        deviceId: client.deviceId,
        credentialId: client.credentialId,
        transport: client.transport,
        operation,
        operationClass,
      });
    } catch {
      return dataErrorResponse(
        503,
        "mutation-admission-failed",
        `The Product Host could not durably admit this mutation. Reference request ${client.requestId}.`,
      );
    }
    const unknown = (): Response => withReceiptId(
      mutationOutcomeUnknownResponse(client.requestId),
      lease.operationId,
    );
    let completed: RecordedMutation;
    try {
      completed = await mutate();
    } catch {
      try {
        lease.finish({
          state: "interrupted",
          resultCode: "mutation-outcome-unknown",
          adoptionState: "unknown",
          recoveryRequired: true,
        });
      } catch {
        // The admitted row intentionally remains recoverable on restart.
      }
      return unknown();
    }
    try {
      const finished = lease.finish(completed.terminal);
      if (finished.kind === "terminal-conflict") return unknown();
    } catch {
      return unknown();
    }
    return withReceiptId(completed.response, lease.operationId);
  };

  // ----- POST /transcribe (runs authenticated but outside the vault mutex) -----
  //
  // /transcribe is runtime-free: it touches no vault — it either shells out to
  // a host whisper command (local, private) or uploads the audio to an
  // OpenAI-compatible cloud STT endpoint. Running it inside enqueue() would hold
  // the vault mutex for the call's duration — blocking sessions, /tasks, etc. — so
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

  /** Render one provider-neutral AgentRuntime turn as the stable SSE wire. */
  const streamSessionTurn = (input: {
    readonly session: AgentSession;
    readonly question: string;
    readonly capabilities: ReadonlySet<Capability>;
    readonly requestId?: string | undefined;
    readonly mutationActor?: AuthenticatedMutationActor | undefined;
  }): Response => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    const turn = input.session.send(input.question, controller.signal, input.mutationActor);
    if (turn.failure !== undefined) {
      clearTimeout(timer);
      return agentRuntimeFailureResponse(turn.failure);
    }

    let signalDrained!: () => void;
    const drained = new Promise<void>((resolve) => {
      signalDrained = resolve;
    });
    const activeTurn = { controller, drained };
    activeTurns.add(activeTurn);
    // Compatibility mode opens a Vault per request, so its lazy agent tools
    // retain the historical mutex reservation. Product Host mode owns one
    // long-lived Vault and generation holds no global lease.
    if (opts.operationScheduler === undefined) void enqueue(() => drained);

    const body = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        let stopReason: string | null = null;
        let error: string | null = null;
        let answer = "";
        let terminalEmitted = false;
        let changes: ReadonlyArray<{ readonly path: string; readonly kind: string }> = [];
        try {
          for await (const event of turn.events) {
            if (event.kind === "text") {
              answer += event.text;
              ctrl.enqueue(encodeAgentStreamEvent({
                schema: AGENT_STREAM_SCHEMA,
                type: "text",
                text: event.text,
              }));
              continue;
            }
            if (event.kind === "error") {
              const detail = controller.signal.aborted
                ? `ask exceeded ${timeoutMs}ms.`
                : event.message;
              error = detail;
              ctrl.enqueue(encodeAgentStreamEvent({
                schema: AGENT_STREAM_SCHEMA,
                type: "error",
                code: controller.signal.aborted ? "turn-timeout" : event.code ?? "agent-failed",
                message: publicAgentError(detail, controller.signal.aborted, input.requestId),
                retryable: event.code !== "turn-limit" && event.code !== "message-too-large",
              }));
              terminalEmitted = true;
              break;
            }
            stopReason = event.stopReason;
            changes = event.changes;
            ctrl.enqueue(encodeAgentStreamEvent({
              schema: AGENT_STREAM_SCHEMA,
              type: "done",
              citations: event.citations.map((citation) => ({
                path: citation.path,
                ...(citation.commit !== undefined ? { commit: citation.commit } : {}),
                ...(citation.snippet !== undefined ? { snippet: citation.snippet } : {}),
              })),
              changes: [...event.changes],
              stopReason: event.stopReason,
            }));
            terminalEmitted = true;
          }
        } catch (cause) {
          const detail = controller.signal.aborted
            ? `ask exceeded ${timeoutMs}ms.`
            : cause instanceof Error
              ? cause.message
              : String(cause);
          error = detail;
          if (!terminalEmitted) {
            ctrl.enqueue(encodeAgentStreamEvent({
              schema: AGENT_STREAM_SCHEMA,
              type: "error",
              code: controller.signal.aborted ? "turn-timeout" : "agent-failed",
              message: publicAgentError(detail, controller.signal.aborted, input.requestId),
              retryable: true,
            }));
            terminalEmitted = true;
          }
        } finally {
          agentLog({
            ts: new Date().toISOString(),
            route: "/sessions/:id/messages",
            question: input.question,
            capabilities: [...input.capabilities].sort(),
            authorEnabled: has(input.capabilities, "author"),
            changes,
            stopReason,
            answerPreview: answer.slice(0, 500),
            durationMs: Date.now() - startedAt,
            error,
          });
          clearTimeout(timer);
          signalDrained();
          activeTurns.delete(activeTurn);
          ctrl.close();
        }
      },
    });

    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
      },
    });
  };

  const routes = async (
    request: Request,
    client?: DeviceRequestContext,
  ): Promise<Response> => {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    const requestGranted = client?.capabilities ?? granted;

    const sessionRoute = /^\/sessions\/([^/]+)(\/(?:messages|cancel))?$/.exec(url.pathname);
    const pluginViewRoute = /^\/views\/([^/]+)$/.exec(url.pathname);
    const need = ROUTE_CAPABILITY[route] ??
      (request.method === "POST" && pluginViewRoute !== null ? "read" : undefined) ??
      (sessionRoute !== null ? "converse" : undefined);
    if (need !== undefined && !has(requestGranted, need)) {
      return dataErrorResponse(403, "capability-denied", `route ${route} requires the '${need}' capability.`);
    }

    if (route === "GET /" || route === "GET /healthz") {
      return jsonResponse(200, {
        schema: SERVER_SCHEMA,
        server: "dome",
        ...(opts.readiness === undefined ? { vault: opts.vaultPath } : {}),
        capabilities: [...requestGranted].sort(),
      });
    }

    if (route === "POST /sessions") {
      const created = agentRuntime.tryCreateSession(client === undefined
        ? undefined
        : { deviceId: client.deviceId, capabilities: client.capabilities });
      if (!created.ok) return agentRuntimeFailureResponse(created.failure);
      const session = created.session;
      return jsonResponse(201, {
        schema: AGENT_SESSION_SCHEMA,
        status: "created",
        sessionId: session.id,
      });
    }

    if (
      request.method === "DELETE" &&
      sessionRoute !== null &&
      sessionRoute[2] === undefined
    ) {
      const id = sessionRoute[1] ?? "";
      const existing = agentRuntime.getSession(id);
      const closed = existing !== null && sessionOwnedBy(existing, client) &&
        agentRuntime.closeSession(id);
      return closed
        ? jsonResponse(200, {
            schema: AGENT_SESSION_SCHEMA,
            status: "closed",
            sessionId: id,
          })
        : dataErrorResponse(404, "session-not-found", `agent session '${id}' was not found.`);
    }

    if (
      request.method === "POST" &&
      sessionRoute !== null &&
      sessionRoute[2] === "/cancel"
    ) {
      const id = sessionRoute[1] ?? "";
      const lookup = agentRuntime.lookupSession(id);
      if (lookup.kind !== "active" || !sessionOwnedBy(lookup.session, client)) {
        const ownedExpiry = lookup.kind === "expired" &&
          lookup.ownerDeviceId === (client?.deviceId ?? null);
        return dataErrorResponse(
          ownedExpiry ? 410 : 404,
          ownedExpiry ? "session-expired" : "session-not-found",
          ownedExpiry ? "The agent session expired." : `agent session '${id}' was not found.`,
        );
      }
      const result = lookup.session.cancel();
      return jsonResponse(200, {
        schema: AGENT_SESSION_SCHEMA,
        status: result.kind,
        sessionId: id,
      });
    }

    if (
      request.method === "POST" &&
      sessionRoute !== null &&
      sessionRoute[2] === "/messages"
    ) {
      const id = sessionRoute[1] ?? "";
      const lookup = agentRuntime.lookupSession(id);
      if (lookup.kind !== "active" || !sessionOwnedBy(lookup.session, client)) {
        const ownedExpiry = lookup.kind === "expired" &&
          lookup.ownerDeviceId === (client?.deviceId ?? null);
        return dataErrorResponse(
          ownedExpiry ? 410 : 404,
          ownedExpiry ? "session-expired" : "session-not-found",
          ownedExpiry ? "The agent session expired." : `agent session '${id}' was not found.`,
        );
      }
      const session = lookup.session;
      const read = await jsonBody(request, maxBodyBytes);
      if (read.kind === "too-large") {
        return dataErrorResponse(413, "payload-too-large", `request body exceeds the ${maxBodyBytes}-byte limit.`);
      }
      if (read.body === null) {
        return dataErrorResponse(400, "invalid-json", "request body is not valid JSON.");
      }
      const message = typeof read.body.message === "string"
        ? read.body.message.trim()
        : "";
      if (message.length === 0) {
        return dataErrorResponse(
          400,
          "agent-message-usage",
          "POST /sessions/:id/messages requires a non-empty `message`.",
        );
      }
      return streamSessionTurn({
        session,
        question: message,
        capabilities: requestGranted,
        ...(client !== undefined ? { requestId: client.requestId } : {}),
        ...(client !== undefined ? { mutationActor: mutationActorOf(client) } : {}),
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
      const captureText = body.text;
      // performCapture is runtime-free (writes a raw file + a human commit) —
      // no enqueue/withVault needed, same as the http server.
      return recordMutation(client, "capture", "workspace-mutation", async () => {
        const outcome = await performCapture({
          text: captureText,
          ...(typeof body.title === "string" ? { title: body.title } : {}),
          ...(typeof body.captureId === "string" ? { captureId: body.captureId } : {}),
          vault: opts.vaultPath,
          source: "http",
        });
        const doc = captureJsonDocument(outcome);
        if (outcome.kind === "error") return {
          response: outcome.exitCode === 64 || client === undefined
            ? jsonResponse(outcome.exitCode === 64 ? 400 : 500, doc)
            : mutationOutcomeUnknownResponse(client.requestId),
          terminal: outcome.exitCode === 64
            ? { state: "rejected", resultCode: "capture-invalid" }
            : { state: "interrupted", resultCode: "mutation-outcome-unknown", adoptionState: "unknown", recoveryRequired: true },
        };
        return {
          response: jsonResponse(200, doc),
          terminal: outcome.kind === "captured"
            ? { state: "succeeded", resultCode: "captured", commitOid: outcome.result.commit }
            : { state: "succeeded", resultCode: "duplicate" },
        };
      });
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
      const run = await dispatchHttpView(
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
      return recordMutation(client, "resolve", "operational-transaction", async () => {
        let terminal!: FinishRequestReceiptInput;
        const response = await withVault("POST /resolve", async (v) => {
          const outcome = await v.resolve(id, value);
          terminal = outcome.kind === "answered" || outcome.kind === "already-answered"
            ? { state: "succeeded", resultCode: outcome.kind }
            : { state: "rejected", resultCode: outcome.kind };
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
        return terminal === undefined
          ? {
              response: client === undefined ? response : mutationOutcomeUnknownResponse(client.requestId),
              terminal: { state: "interrupted", resultCode: "mutation-outcome-unknown", adoptionState: "unknown", recoveryRequired: true },
            }
          : { response, terminal };
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
      const deferUntil = typeof body?.deferUntil === "string" ? body.deferUntil : undefined;
      if (blockId.length === 0 || !["close", "defer", "keep"].includes(disposition)) {
        return dataErrorResponse(400, "settle-usage", "POST /settle requires a JSON body with non-empty `blockId` and `disposition` (optional `deferUntil`).");
      }
      if (disposition === "defer" && (deferUntil === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(deferUntil))) {
        return jsonResponse(400, settleResultJson({
          status: "invalid",
          message: "POST /settle requires a JSON body with non-empty `blockId` and `disposition` (optional `deferUntil`).",
        }));
      }
      // performSettle is runtime-free (locates the line + a human commit) —
      // no enqueue/withVault needed, same as POST /capture.
      return recordMutation(client, "settle", "workspace-mutation", async () => {
        const outcome = await performSettle(opts.vaultPath, {
          blockId,
          disposition: disposition as "close" | "defer" | "keep",
          ...(deferUntil !== undefined ? { deferUntil } : {}),
        });
        const doc = settleResultJson(outcome);
        if (outcome.status === "settled") return {
          response: jsonResponse(200, doc),
          terminal: { state: "succeeded", resultCode: outcome.commit === undefined ? "settled-noop" : "settled", ...(outcome.commit !== undefined ? { commitOid: outcome.commit } : {}) },
        };
        if (outcome.status === "not-found") return {
          response: jsonResponse(404, doc),
          terminal: { state: "rejected", resultCode: "not-found" },
        };
        return {
          response: client === undefined
            ? jsonResponse(400, doc)
            : mutationOutcomeUnknownResponse(client.requestId),
          terminal: { state: "interrupted", resultCode: "mutation-outcome-unknown", adoptionState: "unknown", recoveryRequired: true },
        };
      });
    }

    if (route === "GET /proposals") {
      // collectProposals is runtime-free (reads proposals.db directly) —
      // no enqueue/withVault needed, same as POST /capture and POST /settle.
      const all = url.searchParams.get("all") === "1";
      const doc = proposalsJson(await collectProposals(opts.vaultPath, { all }));
      return jsonResponse(200, doc);
    }

    if (route === "GET /attention") {
      return withVault("GET /attention", async (vault) =>
        jsonResponse(200, await vault.attention())
      );
    }

    if (route === "GET /agent-work") {
      const limit = positiveInt(url.searchParams.get("limit"));
      const questionId = positiveInt(url.searchParams.get("questionId"));
      return withVault("GET /agent-work", async (vault) =>
        jsonResponse(200, await vault.agentWork({
          ...(limit !== null ? { limit } : {}),
          ...(questionId !== null ? { questionId } : {}),
        }))
      );
    }

    if (route === "POST /agent-work/complete") {
      const read = await jsonBody(request, maxBodyBytes);
      if (read.kind === "too-large") {
        return dataErrorResponse(413, "payload-too-large", `request body exceeds the ${maxBodyBytes}-byte limit.`);
      }
      const body = read.body;
      const questionId = typeof body?.questionId === "number" &&
          Number.isInteger(body.questionId) && body.questionId > 0
        ? body.questionId
        : null;
      const expectedRevision = typeof body?.expectedRevision === "string"
        ? body.expectedRevision.trim()
        : "";
      const answer = typeof body?.answer === "string" ? body.answer.trim() : "";
      const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
      const evidence = z.array(SourceRefSchema).safeParse(body?.evidence);
      if (
        questionId === null || expectedRevision.length === 0 ||
        answer.length === 0 || reason.length === 0 || !evidence.success
      ) {
        return dataErrorResponse(
          400,
          "agent-work-completion-usage",
          "POST /agent-work/complete requires questionId, expectedRevision, answer, reason, and valid evidence SourceRefs.",
        );
      }
      return recordMutation(client, "agent-work-complete", "operational-transaction", async () => {
        let terminal!: FinishRequestReceiptInput;
        const response = await withVault("POST /agent-work/complete", async (vault) => {
          const outcome = await vault.completeAgentWork({
          questionId,
          expectedRevision,
          answer,
          reason,
          evidence: evidence.data as unknown as ReadonlyArray<SourceRef>,
        });
          terminal = outcome.kind === "completed" || outcome.kind === "already-completed"
            ? { state: "succeeded", resultCode: outcome.kind }
            : { state: "rejected", resultCode: outcome.kind };
          if (outcome.kind === "not-found") {
          return jsonResponse(404, {
            schema: "dome.agent-work-completion/v1",
            status: "not-found",
            questionId,
          });
        }
        if (outcome.kind === "rejected") {
          return jsonResponse(409, {
            schema: "dome.agent-work-completion/v1",
            status: "rejected",
            problem: outcome.problem,
            message: outcome.message,
          });
        }
          return jsonResponse(200, {
          schema: "dome.agent-work-completion/v1",
          status: outcome.kind,
          question: questionRecordJson(outcome.record),
          handlers: outcome.handlers === null
            ? null
            : answerHandlersJson(outcome.handlers),
          });
        });
        return terminal === undefined
          ? {
              response: client === undefined ? response : mutationOutcomeUnknownResponse(client.requestId),
              terminal: { state: "interrupted", resultCode: "mutation-outcome-unknown", adoptionState: "unknown", recoveryRequired: true },
            }
          : { response, terminal };
      });
    }

    if (route === "POST /agent-work/drain") {
      if (!has(requestGranted, "resolve")) {
        return dataErrorResponse(
          403,
          "capability-denied",
          "route POST /agent-work/drain requires the 'resolve' capability.",
        );
      }
      const read = await jsonBody(request, maxBodyBytes);
      if (read.kind === "too-large") {
        return dataErrorResponse(413, "payload-too-large", `request body exceeds the ${maxBodyBytes}-byte limit.`);
      }
      const requested = read.body?.limit;
      const limit = requested === undefined
        ? 5
        : typeof requested === "number" && Number.isInteger(requested) &&
            requested > 0 && requested <= 10
          ? requested
          : null;
      if (limit === null) {
        return dataErrorResponse(
          400,
          "agent-work-drain-usage",
          "POST /agent-work/drain accepts an optional integer limit from 1 to 10.",
        );
      }
      return recordMutation(client, "agent-work-drain", "operational-transaction", async () => {
        let terminal: FinishRequestReceiptInput | undefined;
        const response = await withVault("POST /agent-work/drain", async (vault) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const agent = opts.agentWorkAgent?.(vault) ??
              createBuiltInAgentWorkAgent({
                vault,
                ...(opts.model !== undefined ? { modelId: opts.model } : {}),
              });
            const drained = await drainAgentWork(vault, agent, {
              limit,
              signal: controller.signal,
            });
            terminal = { state: "succeeded", resultCode: "agent-work-drained" };
            return jsonResponse(200, drained);
          } finally {
            clearTimeout(timer);
          }
        });
        return terminal === undefined
          ? {
              response: client === undefined ? response : mutationOutcomeUnknownResponse(client.requestId),
              terminal: { state: "interrupted", resultCode: "mutation-outcome-unknown", adoptionState: "unknown", recoveryRequired: true },
            }
          : { response, terminal };
      });
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
      return recordMutation(client, "apply-proposal", "workspace-mutation", async () => {
        const outcome = await performApply(opts.vaultPath, id);
        const doc = applyResultJson(outcome);
        const status = outcome.status === "not-found" ? 404 : outcome.status === "not-pending" || outcome.status === "stale" ? 409 : outcome.status === "invalid" ? 400 : 200;
        return {
          response: outcome.status === "invalid" && client !== undefined
            ? mutationOutcomeUnknownResponse(client.requestId)
            : jsonResponse(status, doc),
          terminal: outcome.status === "applied"
            ? { state: "succeeded", resultCode: outcome.commit === undefined ? "applied-noop" : "applied", ...(outcome.commit !== undefined ? { commitOid: outcome.commit } : {}), ...(outcome.recoveryRequired === true ? { recoveryRequired: true } : {}) }
            : outcome.status === "invalid" && client !== undefined
              ? { state: "interrupted", resultCode: "mutation-outcome-unknown", adoptionState: "unknown", recoveryRequired: true }
              : { state: "rejected", resultCode: outcome.status },
        };
      });
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
      return recordMutation(client, "reject-proposal", "operational-transaction", async () => {
        const outcome = await performReject(opts.vaultPath, id, note);
        const doc = rejectResultJson(outcome);
        const status = outcome.status === "not-found" ? 404 : outcome.status === "not-pending" ? 409 : outcome.status === "invalid" ? 400 : 200;
        return {
          response: jsonResponse(status, doc),
          terminal: outcome.status === "rejected"
            ? { state: "succeeded", resultCode: "proposal-rejected" }
            : { state: "rejected", resultCode: outcome.status },
        };
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

    // ----- read-only views (from the former `dome http`) ---------------------

    if (route === "GET /status") {
      if (opts.readiness !== undefined) {
        return dataErrorResponse(
          410,
          "use-product-readiness",
          "Product Host clients use GET /readyz; the operator status document is compatibility-only.",
        );
      }
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
      const run = await dispatchHttpView(
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
      const run = await dispatchHttpView(
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

    if (route === "GET /source") {
      const path = url.searchParams.get("path") ?? "";
      const commit = url.searchParams.get("commit") ?? "";
      const source = await readSourceDocument({
        vaultPath: opts.vaultPath,
        path,
        commit,
      });
      return jsonResponse(sourceDocumentHttpStatus(source), source);
    }

    if (route === "GET /questions") {
      return withVault("GET /questions", async (v) => {
        const rows = await v.listQuestions({ resolved: false });
        return jsonResponse(200, { schema: QUESTIONS_SCHEMA, count: rows.length, questions: rows.map((row) => questionRecordJson(row)) });
      });
    }

    if (route === "GET /views") {
      return withVault("views", async (vault) =>
        jsonResponse(200, collectViews(vault))
      );
    }

    if (request.method === "POST" && pluginViewRoute !== null) {
      const command = decodeURIComponent(pluginViewRoute[1] ?? "").trim();
      if (command.length === 0) {
        return dataErrorResponse(400, "view-usage", "POST /views/:command requires a non-empty command.");
      }
      const read = await jsonBody(request, maxBodyBytes);
      if (read.kind === "too-large") {
        return dataErrorResponse(413, "payload-too-large", `request body exceeds the ${maxBodyBytes}-byte limit.`);
      }
      if (read.body === null) {
        return dataErrorResponse(400, "invalid-json", "request body is not valid JSON.");
      }
      return withVault(`views/${command}`, async (vault) => {
        const document = await runInstalledView(vault, command, read.body);
        return jsonResponse(viewRunStatus(document), document);
      });
    }

    return dataErrorResponse(404, "not-found", `no route for ${route}.`);
  };

  const handleDevice = async (request: Request): Promise<Response> => {
    const deviceAuth = opts.deviceAuth!;
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/pair/status") {
      const auth = authenticateDeviceRequest(deviceAuth.authority, request, {
        allowedOrigins: deviceAuth.allowedOrigins(),
      });
      if (!auth.ok) {
        return hardenDeviceResponse(jsonResponse(200, {
          schema: "dome.device.pairing/v1",
          available: true,
          paired: false,
        }), { requestId: auth.failure.requestId });
      }
      return hardenDeviceResponse(jsonResponse(200, {
        schema: "dome.device.pairing/v1",
        available: true,
        paired: true,
        device: {
          id: auth.context.deviceId,
          name: auth.context.deviceName,
          capabilities: [...auth.context.capabilities].sort(),
        },
      }), { requestId: auth.context.requestId });
    }
    if (request.method === "POST" && url.pathname === "/pair") {
      const requestId = randomUUID();
      if (!requestOriginAllowed(request, deviceAuth.allowedOrigins())) {
        return hardenDeviceResponse(
          dataErrorResponse(403, "origin-forbidden", "The request origin is not allowed."),
          { requestId },
        );
      }
      const read = await jsonBody(request, Math.min(maxBodyBytes, 4_096));
      if (read.kind === "too-large") {
        return hardenDeviceResponse(
          dataErrorResponse(413, "payload-too-large", "pairing request is too large."),
          { requestId },
        );
      }
      const code = typeof read.body?.code === "string" ? read.body.code : "";
      const exchanged = exchangeDevicePairing(deviceAuth.authority, {
        pairingCode: code,
        requestOrigin: request.headers.get("origin") ?? "",
        requestId,
      });
      if (!exchanged.ok) {
        return hardenDeviceResponse(dataErrorResponse(
          exchanged.failure.status,
          exchanged.failure.code,
          exchanged.failure.message,
        ), { requestId });
      }
      const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
      for (const cookie of exchanged.setCookies) headers.append("set-cookie", cookie);
      return hardenDeviceResponse(new Response(JSON.stringify({
        schema: "dome.device.pairing/v1",
        status: "paired",
        device: {
          id: exchanged.deviceId,
          name: exchanged.deviceName,
          capabilities: [...exchanged.capabilities].sort(),
        },
        credentialExpiresAt: exchanged.credentialExpiresAt,
        csrfToken: exchanged.csrfToken,
      }), { status: 200, headers }), { requestId });
    }
    const requestId = randomUUID();
    const font = fontResponse(request);
    if (font !== null) return hardenDeviceResponse(font, { requestId, preserveStaticCacheControl: true });
    if (request.method === "GET" && opts.staticDir !== undefined) {
      const served = await serveStatic(opts.staticDir, url.pathname);
      if (served !== null) {
        return hardenDeviceResponse(served, { requestId, preserveStaticCacheControl: true });
      }
    }
    const authenticated = authenticateDeviceRequest(deviceAuth.authority, request, {
      allowedOrigins: deviceAuth.allowedOrigins(),
      requestId,
    });
    if (!authenticated.ok) {
      return hardenDeviceResponse(dataErrorResponse(
        authenticated.failure.status,
        authenticated.failure.code,
        authenticated.failure.message,
      ), { requestId });
    }
    const client = authenticated.context;
    if (request.method === "GET" && url.pathname === "/readyz") {
      const response = opts.readiness === undefined
        ? dataErrorResponse(404, "readiness-unavailable", "product readiness is not configured.")
        : jsonResponse(200, await opts.readiness(client));
      return hardenDeviceResponse(response, { requestId });
    }
    if (request.method === "POST" && url.pathname === "/transcribe") {
      const response = !has(client.capabilities, "capture")
        ? dataErrorResponse(403, "capability-denied", "route POST /transcribe requires the 'capture' capability.")
        : await handleTranscribe(request);
      return hardenDeviceResponse(await redactDeviceOperationalFailure(response), { requestId });
    }
    try {
      const response = opts.operationScheduler === undefined
        ? await enqueue(() => routes(request, client))
        : await opts.operationScheduler.run(operationClassFor(request), () => routes(request, client));
      return hardenDeviceResponse(response, { requestId });
    } catch (error) {
      return hardenDeviceResponse(operationFailureResponse(error), { requestId });
    }
  };

  const handleCompatibility = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const cookieAuthorized = pairing?.authorized(request) === true;
    if (request.method === "GET" && url.pathname === "/pair/status") {
      const paired =
        pairing?.authorized(request) === true || authorized(request, tokenDigest!);
      return jsonResponse(200, {
        schema: "dome.pairing/v1",
        available: pairing !== null,
        paired,
      });
    }
    if (request.method === "POST" && url.pathname === "/pair") {
      if (pairing === null) {
        return dataErrorResponse(404, "pairing-unavailable", "loopback pairing is not enabled.");
      }
      if (!sameLoopbackOriginOrNonBrowser(request, url)) {
        return dataErrorResponse(403, "origin-denied", "pairing requires the listener origin.");
      }
      const read = await jsonBody(request, Math.min(maxBodyBytes, 4_096));
      if (read.kind === "too-large") {
        return dataErrorResponse(413, "payload-too-large", "pairing request is too large.");
      }
      const code = typeof read.body?.code === "string" ? read.body.code : "";
      const exchanged = pairing.exchange(code);
      if (exchanged.kind === "limited") {
        return new Response(JSON.stringify({
          schema: "dome.pairing/v1",
          status: "limited",
          retry_after_seconds: exchanged.retryAfterSeconds,
        }), {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": String(exchanged.retryAfterSeconds),
          },
        });
      }
      if (exchanged.kind === "invalid") {
        return dataErrorResponse(401, "pairing-invalid", "invalid pairing code.");
      }
      return new Response(`${JSON.stringify({
        schema: "dome.pairing/v1",
        status: "paired",
        expires_at: exchanged.expiresAt,
      }, null, 2)}\n`, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": exchanged.cookie,
        },
      });
    }
    // Unauthenticated subresources: cockpit fonts, and (when configured) the PWA shell/assets.
    const font = fontResponse(request);
    if (font !== null) return font;
    if (request.method === "GET" && opts.staticDir !== undefined) {
      const served = await serveStatic(opts.staticDir, url.pathname);
      if (served !== null) return served; // unauthenticated, no mutex
    }
    // Compatibility bearer/query token or the P1 loopback browser cookie.
    if (
      !authorized(request, tokenDigest!) &&
      !queryTokenAuthorized(request, url, tokenDigest!) &&
      !cookieAuthorized
    ) {
      return jsonResponse(401, {
        schema: SERVER_SCHEMA,
        status: "error",
        error: "unauthorized",
        message: "missing or invalid authentication.",
      });
    }
    if (
      cookieAuthorized &&
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      !sameLoopbackOriginOrNonBrowser(request, url)
    ) {
      return dataErrorResponse(403, "origin-denied", "paired browser mutations require the listener origin.");
    }
    if (request.method === "GET" && url.pathname === "/readyz") {
      if (opts.readiness === undefined) {
        return dataErrorResponse(404, "readiness-unavailable", "product readiness is not configured.");
      }
      return jsonResponse(200, await opts.readiness());
    }
    // /transcribe runs authenticated but outside the vault mutex — it touches
    // no vault and can hold a subprocess for many seconds; letting it run
    // inside enqueue() would block sessions, /tasks, etc. for that entire time.
    if (request.method === "POST" && url.pathname === "/transcribe") {
      if (!has(granted, "capture")) {
        return dataErrorResponse(403, "capability-denied", "route POST /transcribe requires the 'capture' capability.");
      }
      return handleTranscribe(request);
    }
    // Cancellation must bypass the compatibility vault mutex held by the
    // active stream it is stopping.
    if (request.method === "POST" && /^\/sessions\/[^/]+\/cancel$/.test(url.pathname)) {
      return routes(request);
    }
    try {
      if (opts.operationScheduler === undefined) {
        return await enqueue(() => routes(request));
      }
      return await opts.operationScheduler.run(
        operationClassFor(request),
        () => routes(request),
      );
    } catch (e) {
      if (e instanceof ProductOperationQueueFullError) {
        return new Response(JSON.stringify({
          schema: SERVER_SCHEMA,
          status: "error",
          error: e.code,
          message: "the Product Host is busy; retry shortly.",
        }), {
          status: 429,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "retry-after": String(Math.max(1, Math.ceil(e.retryAfterMs / 1_000))),
          },
        });
      }
      if (
        e instanceof ProductOperationCancelledError ||
        e instanceof ProductOperationSchedulerClosedError
      ) {
        return dataErrorResponse(503, e.code, "the Product Host is stopping or the operation was cancelled.");
      }
      return dataErrorResponse(500, "internal", "the Product Host could not complete the operation.");
    }
  };

  const handle = deviceMode ? handleDevice : handleCompatibility;

  return Object.freeze({
    fetch: handle,
    close: async () => {
      agentRuntime.close();
      const turns = [...activeTurns];
      for (const turn of turns) turn.controller.abort("http-server-closing");
      await Promise.all(turns.map((turn) => turn.drained));
    },
  });
}

function operationClassFor(request: Request): ProductOperationClass {
  const { pathname } = new URL(request.url);
  if (pathname === "/sessions" || pathname.startsWith("/sessions/")) {
    return "model-generation";
  }
  if (
    (request.method === "GET" && ["/tasks", "/today", "/query", "/status"].includes(pathname)) ||
    (request.method === "POST" && pathname.startsWith("/views/"))
  ) {
    return "view-execution";
  }
  if (
    request.method === "POST" &&
    ["/capture", "/settle", "/apply"].includes(pathname)
  ) {
    return "workspace-mutation";
  }
  if (
    request.method === "GET" &&
    ["/doc", "/source", "/recents"].includes(pathname)
  ) {
    return "immutable-adopted-read";
  }
  return "operational-transaction";
}

function sessionOwnedBy(
  session: AgentSession,
  client: DeviceRequestContext | undefined,
): boolean {
  return client === undefined
    ? session.ownerDeviceId === null
    : session.ownerDeviceId === client.deviceId;
}

function mutationActorOf(client: DeviceRequestContext): AuthenticatedMutationActor {
  return Object.freeze({
    requestId: client.requestId,
    actorId: client.actorId,
    deviceId: client.deviceId,
    credentialId: client.credentialId,
    transport: client.transport,
  });
}

function requestOriginAllowed(
  request: Request,
  allowedOrigins: ReadonlyArray<string>,
): boolean {
  const raw = request.headers.get("origin");
  if (raw === null) return false;
  try {
    const origin = new URL(raw);
    if (
      origin.username !== "" ||
      origin.password !== "" ||
      origin.pathname !== "/" ||
      origin.search !== "" ||
      origin.hash !== ""
    ) return false;
    return allowedOrigins.some((allowed) => {
      try {
        return new URL(allowed).origin === origin.origin;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function operationFailureResponse(error: unknown): Response {
  if (error instanceof ProductOperationQueueFullError) {
    return new Response(JSON.stringify({
      schema: SERVER_SCHEMA,
      status: "error",
      error: error.code,
      message: "the Product Host is busy; retry shortly.",
    }), {
      status: 429,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "retry-after": String(Math.max(1, Math.ceil(error.retryAfterMs / 1_000))),
      },
    });
  }
  if (
    error instanceof ProductOperationCancelledError ||
    error instanceof ProductOperationSchedulerClosedError
  ) {
    return dataErrorResponse(503, error.code, "the Product Host is stopping or the operation was cancelled.");
  }
  return dataErrorResponse(500, "internal", "the Product Host could not complete the operation.");
}

function agentRuntimeFailureResponse(failure: AgentRuntimeFailure): Response {
  const status = failure.code === "message-empty" || failure.code === "message-too-large"
    ? 400
    : failure.code === "session-expired" || failure.code === "session-closed" || failure.code === "turn-limit"
      ? 410
      : 429;
  const response = dataErrorResponse(status, failure.code, failure.message);
  if (status === 429) response.headers.set("retry-after", "1");
  return response;
}

function publicAgentError(
  detail: string,
  aborted: boolean,
  requestId: string | undefined,
): string {
  if (requestId === undefined || aborted) return detail;
  return `The assistant turn failed. Reference request ${requestId}.`;
}

async function redactDeviceOperationalFailure(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  let code = "internal";
  try {
    const body = await response.clone().json() as { readonly error?: unknown };
    if (typeof body.error === "string" && /^[a-z0-9-]+$/.test(body.error)) code = body.error;
  } catch {
    // The public device envelope remains stable even for a malformed provider response.
  }
  return dataErrorResponse(
    response.status,
    code,
    code.startsWith("transcribe-")
      ? "Transcription could not be completed."
      : "The Product Host could not complete the request.",
  );
}

function sameLoopbackOriginOrNonBrowser(request: Request, url: URL): boolean {
  const origin = request.headers.get("origin");
  if (origin === null || origin === url.origin) return true;
  try {
    const originUrl = new URL(origin);
    return isLoopbackHostname(originUrl.hostname) && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}
