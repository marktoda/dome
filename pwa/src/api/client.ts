import type { AgentSession, AgentStopOutcome, AgentStreamOutcome, CaptureResult, PairingResult, PairingStatus, Recents, ResolveResult, SettleDisposition, SettleResult, StreamEvent, Today, Transcript } from "./types";
import {
  parseCaptureReceipt,
  type CaptureRequest,
} from "../../../contracts/capture";
import {
  AGENT_STREAM_SCHEMA,
  AgentStreamProtocolError,
  createAgentStreamDecoder,
} from "../../../contracts/agent-stream";
import {
  fetchSourceDocument,
  type ExactCitation,
} from "../source/source-client";
import type { SourceDocumentResult } from "../../../contracts/source-document";
import {
  parseProductReadiness,
  type ProductReadiness,
} from "../../../contracts/product-readiness";
import { todayPayloadSchema } from "../../../src/surface/today-view";

export type AgentTurnHandle = {
  turnId: string;
  result: Promise<AgentStreamOutcome>;
  stop: () => Promise<AgentStopOutcome>;
};

export type ConnectionFailure =
  | { readonly kind: "transport"; readonly cause: unknown }
  | { readonly kind: "auth-required" };
export type TransportFailureTicket = (failure: ConnectionFailure) => void;
export type BeginTransportRequest = () => TransportFailureTicket;

export type ReadinessResult =
  | { readonly kind: "ready"; readonly document: ProductReadiness }
  | { readonly kind: "offline" }
  | { readonly kind: "unreachable" }
  | { readonly kind: "auth-required" }
  | { readonly kind: "readiness-failed"; readonly status: number }
  | { readonly kind: "incompatible" };

/** A request never reached an HTTP response; callers may downgrade transport availability. */
export class DomeTransportError extends Error {
  constructor(cause: unknown) {
    super("Dome Home could not be reached.", { cause });
    this.name = "DomeTransportError";
  }
}

let nextTurnId = 1;
const AGENT_SESSION_SCHEMA = "dome.agent-session/v1";

export class DomeClient {
  private sessionPromise: Promise<string> | null = null;
  private csrfToken: string | null = null;

  constructor(
    private readonly token: string = "",
    private readonly baseUrl: string = "",
    private readonly beginTransportRequest?: BeginTransportRequest,
  ) {}

  private authHeaders(json: boolean): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.token.length > 0) h.authorization = `Bearer ${this.token}`;
    if (json) h["content-type"] = "application/json";
    return h;
  }

  private request(path: string, init: RequestInit = {}): Request {
    const headers = new Headers(init.headers);
    const method = (init.method ?? "GET").toUpperCase();
    if (this.csrfToken !== null && method !== "GET" && method !== "HEAD") {
      headers.set("x-dome-csrf", this.csrfToken);
    }
    return new Request(this.url(path), { ...init, headers, credentials: "same-origin" });
  }

  private url(path: string): string {
    const origin =
      typeof location !== "undefined" && location.origin !== "null"
        ? location.origin
        : "http://dome.local";
    const base = this.baseUrl.replace(/\/+$/, "");
    return new URL(`${base}${path}`, origin).toString();
  }

  private async parse<T>(res: Response): Promise<T> {
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const msg = body && typeof body["error"] === "string"
        ? `${body["error"]}${typeof body["message"] === "string" ? `: ${body["message"]}` : ""}`
        : `request failed (${res.status})`;
      throw new Error(msg);
    }
    return body as T;
  }

  async tasks(date?: string): Promise<Today> {
    const q = date !== undefined ? `?date=${encodeURIComponent(date)}` : "";
    const value = await this.parse<unknown>(
      await this.fetchResponse(this.request(`/tasks${q}`, { headers: this.authHeaders(false) })),
    );
    const parsed = todayPayloadSchema.safeParse(value);
    if (typeof value !== "object" || value === null ||
      (value as Record<string, unknown>)["schema"] !== "dome.daily.today/v1" ||
      !parsed.success) {
      throw new Error("Today response is incompatible.");
    }
    return value as Today;
  }

  async recents(limit?: number): Promise<Recents> {
    const q = limit !== undefined ? `?limit=${limit}` : "";
    return this.parse<Recents>(await this.fetchResponse(this.request(`/recents${q}`, { headers: this.authHeaders(false) })));
  }

  private transportFailureTicket(request: Request): TransportFailureTicket {
    const report = this.beginTransportRequest?.();
    let reported = false;
    return (failure: ConnectionFailure): void => {
      if (reported || report === undefined || request.signal.aborted ||
        (failure.kind === "transport" && isAbortError(failure.cause))) return;
      reported = true;
      report(failure);
    };
  }

  private async fetchResponse(
    request: Request,
    reportTransportFailure: TransportFailureTicket = this.transportFailureTicket(request),
    observeAuthFailure: boolean = true,
  ): Promise<Response> {
    try {
      const response = await fetch(request);
      if (observeAuthFailure && response.status === 401) {
        this.retireSessionIdentity();
        reportTransportFailure({ kind: "auth-required" });
      }
      return response;
    } catch (error) {
      reportTransportFailure({ kind: "transport", cause: error });
      throw new DomeTransportError(error);
    }
  }

  /** Authenticated product truth. Invalid or failed documents never become authority. */
  async readiness(): Promise<ReadinessResult> {
    let response: Response;
    try {
      response = await this.fetchResponse(this.request("/readyz", {
        headers: this.authHeaders(false),
      }));
    } catch (error) {
      if (!(error instanceof DomeTransportError)) throw error;
      return { kind: navigator.onLine === false ? "offline" : "unreachable" };
    }
    if (response.status === 401) return { kind: "auth-required" };
    if (!response.ok) return { kind: "readiness-failed", status: response.status };
    const value = await response.json().catch(() => null);
    try {
      return { kind: "ready", document: parseProductReadiness(value) };
    } catch {
      return { kind: "incompatible" };
    }
  }

  async capture(input: CaptureRequest): Promise<CaptureResult> {
    const value = await this.parse<unknown>(await this.fetchResponse(this.request("/capture", { method: "POST", headers: this.authHeaders(true), body: JSON.stringify(input) })));
    return parseCaptureReceipt(value);
  }

  async resolve(id: number, value: string): Promise<ResolveResult> {
    return this.parse<ResolveResult>(await this.fetchResponse(this.request("/resolve", { method: "POST", headers: this.authHeaders(true), body: JSON.stringify({ id, value }) })));
  }

  async settle(blockId: string, disposition: SettleDisposition, deferUntil?: string): Promise<SettleResult> {
    const body = { blockId, disposition, ...(deferUntil !== undefined ? { deferUntil } : {}) };
    return this.parse<SettleResult>(await this.fetchResponse(this.request("/settle", { method: "POST", headers: this.authHeaders(true), body: JSON.stringify(body) })));
  }

  async transcribe(audio: Blob): Promise<Transcript> {
    return this.parse<Transcript>(await this.fetchResponse(this.request("/transcribe", { method: "POST", headers: { ...this.authHeaders(false), "content-type": audio.type || "audio/webm" }, body: audio })));
  }

  async pairingStatus(): Promise<PairingStatus> {
    return this.parse<PairingStatus>(await this.fetchResponse(this.request("/pair/status")));
  }

  async source(citation: ExactCitation, signal?: AbortSignal): Promise<SourceDocumentResult> {
    return fetchSourceDocument(
      citation,
      (request) => this.fetchResponse(request),
      signal,
    );
  }

  async pair(code: string): Promise<PairingResult> {
    const request = this.request("/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const paired = await this.parse<PairingResult>(await this.fetchResponse(
      request,
      this.transportFailureTicket(request),
      false,
    ));
    this.retireSessionIdentity();
    if (paired.csrfToken !== undefined) this.csrfToken = paired.csrfToken;
    return paired;
  }

  restoreCsrfFromCookie(cookieHeader: string): boolean {
    const csrf = cookieHeader.split(";").map((part) => part.trim())
      .find((part) => part.startsWith("dome_csrf="));
    if (csrf === undefined) return false;
    try {
      const value = decodeURIComponent(csrf.slice("dome_csrf=".length));
      if (value.length === 0) return false;
      this.csrfToken = value;
      return true;
    } catch {
      return false;
    }
  }

  async agentStream(question: string, onEvent: (e: StreamEvent) => void, signal?: AbortSignal): Promise<AgentStreamOutcome> {
    const turn = this.startAgentTurn(question, onEvent);
    let externalStop: Promise<AgentStopOutcome> | null = null;
    const abort = (): void => { externalStop ??= turn.stop(); };
    if (signal !== undefined) {
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
    let outcome: AgentStreamOutcome;
    try {
      outcome = await turn.result;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
    const pendingStop = externalStop as Promise<AgentStopOutcome> | null;
    const stop = pendingStop === null ? null : await pendingStop;
    if (outcome.kind === "cancelled" && outcome.source === "local-abort" && stop !== null) {
      if (stop.kind === "failed" || stop.kind === "session-missing" || stop.kind === "session-expired") return stop;
      if (stop.kind === "cancelled") return { kind: "cancelled", source: "server" };
      return this.failedOutcome(
        "stop-unconfirmed",
        "The response ended while stopping, but the server reported no active turn. Its final effects are unknown.",
        true,
      );
    }
    return outcome;
  }

  startAgentTurn(question: string, onEvent: (e: StreamEvent) => void): AgentTurnHandle {
    const turnId = `turn-${nextTurnId++}`;
    const session = this.sessionId();
    const controller = new AbortController();
    let stopPromise: Promise<AgentStopOutcome> | null = null;
    let settled = false;
    const result = this.runAgentTurn(session, question, onEvent, controller.signal).then(
      (outcome) => {
        settled = true;
        return outcome;
      },
      (error) => {
        settled = true;
        throw error;
      },
    );
    return {
      turnId,
      result,
      stop: () => {
        if (stopPromise !== null) return stopPromise;
        if (settled) return Promise.resolve({ kind: "idle" });
        controller.abort();
        stopPromise = this.cancelSessionTurn(session);
        return stopPromise;
      },
    };
  }

  private async runAgentTurn(session: Promise<string>, question: string, onEvent: (e: StreamEvent) => void, signal: AbortSignal): Promise<AgentStreamOutcome> {
    let sessionId: string;
    try {
      sessionId = await session;
    } catch (error) {
      return this.failedOutcome("session-create-failed", error, true);
    }

    let res: Response;
    const messageRequest = this.request(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: "POST",
      headers: { ...this.authHeaders(true), accept: "text/event-stream" },
      body: JSON.stringify({ message: question }),
      signal,
    });
    const reportTransportFailure = this.transportFailureTicket(messageRequest);
    try {
      res = await this.fetchResponse(messageRequest, reportTransportFailure);
    } catch (error) {
      if (signal.aborted) return { kind: "cancelled", source: "local-abort" };
      return this.failedOutcome("network-error", error, true);
    }

    if (!res.ok) {
      const outcome = await this.httpOutcome(res, session);
      if (outcome.kind === "failed") this.emitFailure(onEvent, outcome);
      return outcome;
    }
    if (res.body === null) {
      const outcome = this.failedOutcome(
        "protocol-premature-eof",
        "The response stream ended unexpectedly.",
        true,
      );
      this.emitFailure(onEvent, outcome);
      return outcome;
    }
    const reader = res.body.getReader();
    const decoder = createAgentStreamDecoder();
    let terminal: StreamEvent | null = null;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const event of decoder.push(value)) {
          onEvent(event);
          if (event.type === "done" || event.type === "error") terminal = event;
        }
      }
      decoder.finish();
      if (terminal?.type === "done") return { kind: "done" };
      if (terminal?.type === "error") {
        if (terminal.code === "turn-cancelled") return { kind: "cancelled", source: "server" };
        return {
          kind: "failed",
          code: terminal.code,
          message: terminal.message,
          retryable: terminal.retryable,
        };
      }
      return this.failedOutcome("protocol-premature-eof", "The response stream ended unexpectedly.", true);
    } catch (error) {
      if (signal.aborted) {
        void reader.cancel().catch(() => {});
        return { kind: "cancelled", source: "local-abort" };
      }
      if (!(error instanceof AgentStreamProtocolError)) {
        void reader.cancel(error).catch(() => {});
        reportTransportFailure({ kind: "transport", cause: error });
        const outcome = this.failedOutcome("network-error", error, true);
        this.emitFailure(onEvent, outcome);
        return outcome;
      }
      void reader.cancel(error).catch(() => {});
      const outcome = this.failedOutcome(
        `protocol-${error.code}`,
        "The response stream was interrupted or invalid.",
        true,
      );
      this.emitFailure(onEvent, outcome);
      return outcome;
    }
  }

  private async cancelSessionTurn(pendingSession: Promise<string>): Promise<AgentStopOutcome> {
    let sessionId: string;
    try {
      sessionId = await pendingSession;
    } catch (error) {
      return this.failedOutcome("session-create-failed", error, true);
    }

    try {
      const res = await this.fetchResponse(this.request(`/sessions/${encodeURIComponent(sessionId)}/cancel`, {
        method: "POST",
        headers: this.authHeaders(false),
      }));
      if (!res.ok) return this.httpOutcome(res, pendingSession);
      const body = await res.json().catch(() => null) as { schema?: unknown; status?: unknown; sessionId?: unknown } | null;
      if (
        body?.schema !== AGENT_SESSION_SCHEMA ||
        (body.status !== "cancelled" && body.status !== "idle") ||
        body.sessionId !== sessionId
      ) {
        return this.failedOutcome(
          "protocol-invalid-cancel-receipt",
          "The server returned an invalid cancellation receipt.",
          true,
        );
      }
      return { kind: body.status };
    } catch (error) {
      return this.failedOutcome("network-error", error, true);
    }
  }

  startNewConversation(): void {
    const previous = this.sessionPromise;
    this.sessionPromise = null;
    if (previous === null) return;
    void previous.then((sessionId) => this.fetchResponse(this.request(`/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
        headers: this.authHeaders(false),
      }))).catch(() => {
      // Clearing local ownership is sufficient; server expiry reclaims an unreachable session.
    });
  }

  private emitFailure(onEvent: (event: StreamEvent) => void, outcome: Extract<AgentStreamOutcome, { kind: "failed" }>): void {
    onEvent({
      schema: AGENT_STREAM_SCHEMA,
      type: "error",
      code: outcome.code,
      message: outcome.message,
      retryable: outcome.retryable,
    });
  }

  private failedOutcome(code: string, error: unknown, retryable: boolean): Extract<AgentStreamOutcome, { kind: "failed" }> {
    return {
      kind: "failed",
      code,
      message: error instanceof Error ? error.message : String(error),
      retryable,
    };
  }

  private async httpOutcome(res: Response, session: Promise<string>): Promise<Extract<AgentStreamOutcome, { kind: "failed" | "session-missing" | "session-expired" }>> {
    const body = await res.json().catch(() => null) as { error?: unknown; message?: unknown } | null;
    const code = typeof body?.error === "string" ? body.error : "http-error";
    const retryAfterSeconds = this.retryAfterSeconds(res.headers.get("retry-after"));
    if (res.status === 404) {
      this.clearSession(session);
      return { kind: "session-missing" };
    }
    if (res.status === 410 || code === "session-expired") {
      this.clearSession(session);
      return { kind: "session-expired" };
    }
    return {
      kind: "failed",
      code,
      message: typeof body?.message === "string" ? body.message : `stream failed (${res.status})`,
      retryable: res.status === 408 || res.status === 429 || res.status >= 500,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    };
  }

  private retryAfterSeconds(value: string | null): number | undefined {
    if (value === null) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
    const at = Date.parse(value);
    return Number.isFinite(at) ? Math.max(0, Math.ceil((at - Date.now()) / 1000)) : undefined;
  }

  private clearSession(session: Promise<string>): void {
    if (this.sessionPromise === session) this.sessionPromise = null;
  }

  private retireSessionIdentity(): void {
    this.sessionPromise = null;
  }

  private sessionId(): Promise<string> {
    if (this.sessionPromise === null) {
      const pending = this.fetchResponse(this.request("/sessions", {
        method: "POST",
        headers: this.authHeaders(false),
      }))
        .then((res) => this.parse<AgentSession>(res))
        .then((session) => session.sessionId);
      this.sessionPromise = pending;
      void pending.catch(() => {
        if (this.sessionPromise === pending) this.sessionPromise = null;
      });
    }
    return this.sessionPromise;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}
