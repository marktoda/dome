import type { AgentSession, ApplyProposalResult, CaptureResult, PairingResult, PairingStatus, Recents, RejectProposalResult, ResolveResult, SettleDisposition, SettleResult, StreamEvent, Today, Transcript } from "./types";
import {
  parseCaptureReceipt,
  type CaptureRequest,
} from "../../../contracts/capture";
import {
  AGENT_STREAM_SCHEMA,
  AgentStreamProtocolError,
  createAgentStreamDecoder,
} from "../../../contracts/agent-stream";

export class DomeClient {
  private sessionPromise: Promise<string> | null = null;
  private csrfToken: string | null = null;

  constructor(private readonly token: string = "", private readonly baseUrl: string = "") {}

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
    return this.parse<Today>(await fetch(this.request(`/tasks${q}`, { headers: this.authHeaders(false) })));
  }

  async recents(limit?: number): Promise<Recents> {
    const q = limit !== undefined ? `?limit=${limit}` : "";
    return this.parse<Recents>(await fetch(this.request(`/recents${q}`, { headers: this.authHeaders(false) })));
  }

  async capture(input: CaptureRequest): Promise<CaptureResult> {
    const value = await this.parse<unknown>(await fetch(this.request("/capture", { method: "POST", headers: this.authHeaders(true), body: JSON.stringify(input) })));
    return parseCaptureReceipt(value);
  }

  async resolve(id: number, value: string): Promise<ResolveResult> {
    return this.parse<ResolveResult>(await fetch(this.request("/resolve", { method: "POST", headers: this.authHeaders(true), body: JSON.stringify({ id, value }) })));
  }

  async applyProposal(id: number): Promise<ApplyProposalResult> {
    return this.parse<ApplyProposalResult>(await fetch(this.request("/apply", {
      method: "POST",
      headers: this.authHeaders(true),
      body: JSON.stringify({ id }),
    })));
  }

  async rejectProposal(id: number): Promise<RejectProposalResult> {
    return this.parse<RejectProposalResult>(await fetch(this.request("/reject", {
      method: "POST",
      headers: this.authHeaders(true),
      body: JSON.stringify({ id }),
    })));
  }

  async settle(blockId: string, disposition: SettleDisposition, deferUntil?: string): Promise<SettleResult> {
    const body = { blockId, disposition, ...(deferUntil !== undefined ? { deferUntil } : {}) };
    return this.parse<SettleResult>(await fetch(this.request("/settle", { method: "POST", headers: this.authHeaders(true), body: JSON.stringify(body) })));
  }

  async transcribe(audio: Blob): Promise<Transcript> {
    return this.parse<Transcript>(await fetch(this.request("/transcribe", { method: "POST", headers: { ...this.authHeaders(false), "content-type": audio.type || "audio/webm" }, body: audio })));
  }

  async pairingStatus(): Promise<PairingStatus> {
    return this.parse<PairingStatus>(await fetch(this.request("/pair/status")));
  }

  async pair(code: string): Promise<PairingResult> {
    const paired = await this.parse<PairingResult>(await fetch(this.request("/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    })));
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

  async agentStream(question: string, onEvent: (e: StreamEvent) => void, signal?: AbortSignal): Promise<void> {
    const sessionId = await this.sessionId();
    const res = await fetch(this.request(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: "POST",
      headers: { ...this.authHeaders(true), accept: "text/event-stream" },
      body: JSON.stringify({ message: question }),
      ...(signal !== undefined ? { signal } : {}),
    }));
    if (!res.ok || res.body === null) {
      onEvent({
        schema: AGENT_STREAM_SCHEMA,
        type: "error",
        code: "http-error",
        message: `stream failed (${res.status})`,
        retryable: res.status === 408 || res.status === 429 || res.status >= 500,
      });
      return;
    }
    const reader = res.body.getReader();
    const decoder = createAgentStreamDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const event of decoder.push(value)) onEvent(event);
      }
      decoder.finish();
    } catch (error) {
      if (!(error instanceof AgentStreamProtocolError)) throw error;
      void reader.cancel(error).catch(() => {});
      onEvent({
        schema: AGENT_STREAM_SCHEMA,
        type: "error",
        code: `protocol-${error.code}`,
        message: "The response stream was interrupted or invalid.",
        retryable: true,
      });
    }
  }

  private sessionId(): Promise<string> {
    if (this.sessionPromise === null) {
      this.sessionPromise = fetch(this.request("/sessions", {
        method: "POST",
        headers: this.authHeaders(false),
      }))
        .then((res) => this.parse<AgentSession>(res))
        .then((session) => session.sessionId)
        .catch((error) => {
          this.sessionPromise = null;
          throw error;
        });
    }
    return this.sessionPromise;
  }
}
