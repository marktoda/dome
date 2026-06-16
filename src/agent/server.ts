// src/agent/server.ts
//
// The "ask my brain" HTTP surface: a single POST /ask route that authenticates
// a bearer token, validates the question body, runs the ask agent, and returns
// the answer + citations.  Mirrors src/http/server.ts auth + mutex idioms
// exactly; the vault/provider plumbing is identical — just a narrower route
// table.

import { createHash, timingSafeEqual } from "node:crypto";
import {
  makeVaultMutex,
  openVaultErrorKind,
  withVault as withVaultShared,
} from "../surface/adapter";
import type { TextStreamPart, ToolSet } from "ai";
import { runAsk, runAskStream, type AskStream } from "./ask";
import type { AskResult } from "./types";

// ----- Constants ------------------------------------------------------------

const SCHEMA = "dome.ask/v1";

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

/** Constant-time bearer check: compare SHA-256 digests, never raw strings. */
function authorized(request: Request, tokenDigest: Buffer): boolean {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match === null || match[1] === undefined) return false;
  return timingSafeEqual(sha256(match[1]), tokenDigest);
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

  const routes = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;

    if (route === "GET /") {
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

    return errorResponse(404, "not-found", `no route for ${route}.`);
  };

  const handle = async (request: Request): Promise<Response> => {
    if (!authorized(request, tokenDigest)) {
      return jsonResponse(401, {
        schema: SCHEMA,
        status: "error",
        error: "unauthorized",
        message: "missing or invalid bearer token.",
      });
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
