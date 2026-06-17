import type { AskResult, CaptureResult, Recents, ResolveResult, Today, Transcript } from "./types";

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

  async ask(question: string): Promise<AskResult> {
    return this.parse<AskResult>(await fetch(new Request(`${this.baseUrl}/ask`, { method: "POST", headers: this.authHeaders(true), body: JSON.stringify({ question }) })));
  }
}
