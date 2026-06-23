import type { AgentResult, CaptureResult, Recents, ResolveResult, StreamEvent, Today, Transcript } from "./types";

// Parse a buffer of SSE text into complete events + the leftover partial frame.
export function parseSseChunk(buffer: string): { events: StreamEvent[]; rest: string } {
  const events: StreamEvent[] = [];
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? ""; // last element is the (possibly empty) partial
  for (const part of parts) {
    const line = part.split("\n").find((l) => l.startsWith("data:"));
    if (line === undefined) continue;
    const json = line.slice("data:".length).trim();
    if (json.length === 0) continue;
    try {
      events.push(JSON.parse(json) as StreamEvent);
    } catch {
      // malformed frame — skip
    }
  }
  return { events, rest };
}

export class DomeClient {
  constructor(private readonly token: string, private readonly baseUrl: string = "") {}

  private authHeaders(json: boolean): Record<string, string> {
    const h: Record<string, string> = { authorization: `Bearer ${this.token}` };
    if (json) h["content-type"] = "application/json";
    return h;
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
    return this.parse<Today>(await fetch(new Request(`${this.baseUrl}/tasks${q}`, { headers: this.authHeaders(false) })));
  }

  async recents(limit?: number): Promise<Recents> {
    const q = limit !== undefined ? `?limit=${limit}` : "";
    return this.parse<Recents>(await fetch(new Request(`${this.baseUrl}/recents${q}`, { headers: this.authHeaders(false) })));
  }

  async capture(input: { text: string; title?: string; captureId?: string }): Promise<CaptureResult> {
    return this.parse<CaptureResult>(await fetch(new Request(`${this.baseUrl}/capture`, { method: "POST", headers: this.authHeaders(true), body: JSON.stringify(input) })));
  }

  async resolve(id: number, value: string): Promise<ResolveResult> {
    return this.parse<ResolveResult>(await fetch(new Request(`${this.baseUrl}/resolve`, { method: "POST", headers: this.authHeaders(true), body: JSON.stringify({ id, value }) })));
  }

  async transcribe(audio: Blob): Promise<Transcript> {
    return this.parse<Transcript>(await fetch(new Request(`${this.baseUrl}/transcribe`, { method: "POST", headers: { ...this.authHeaders(false), "content-type": audio.type || "audio/webm" }, body: audio })));
  }

  async agent(question: string): Promise<AgentResult> {
    return this.parse<AgentResult>(await fetch(new Request(`${this.baseUrl}/agent`, { method: "POST", headers: this.authHeaders(true), body: JSON.stringify({ question }) })));
  }

  async agentStream(question: string, onEvent: (e: StreamEvent) => void, signal?: AbortSignal): Promise<void> {
    const res = await fetch(`${this.baseUrl}/agent/stream`, {
      method: "POST",
      headers: { ...this.authHeaders(true), accept: "text/event-stream" },
      body: JSON.stringify({ question }),
      ...(signal !== undefined ? { signal } : {}),
    });
    if (!res.ok || res.body === null) {
      onEvent({ type: "error", message: `stream failed (${res.status})` });
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseSseChunk(buffer);
      buffer = rest;
      for (const e of events) onEvent(e);
    }
  }
}
