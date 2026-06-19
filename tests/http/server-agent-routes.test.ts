import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDomeHttpServer } from "../../src/http/server";
import type { AgentStream } from "../../src/agent/agent";
import type { TextStreamPart, ToolSet } from "ai";

const TOKEN = "test-token";

/** Build an AgentStream from a fixed list of text deltas (no model needed). */
function fakeStream(
  deltas: string[],
  stopReason: "final" | "budget" = "final",
): AgentStream {
  const citations = [{ path: "wiki/x.md", commit: "c1" }];
  async function* gen(): AsyncIterable<TextStreamPart<ToolSet>> {
    yield { type: "start" } as TextStreamPart<ToolSet>;
    for (const delta of deltas) {
      yield { type: "text-delta", id: "t1", text: delta } as TextStreamPart<ToolSet>;
    }
    yield {
      type: "finish",
      finishReason: stopReason === "final" ? "stop" : "tool-calls",
      rawFinishReason: undefined,
      totalUsage: {},
    } as unknown as TextStreamPart<ToolSet>;
  }
  return {
    fullStream: gen(),
    citations,
    changes: [],
    finished: Promise.resolve({ stopReason }),
  };
}

function server() {
  return createDomeHttpServer({
    vaultPath: "/tmp/unused",
    token: TOKEN,
    agentImpl: async (question: string, _signal: AbortSignal) => ({
      answer: `answer to: ${question}`,
      citations: [{ path: "wiki/x.md", commit: "c1" }],
      steps: 2,
      stopReason: "final" as const,
      changes: [],
    }),
  });
}

function post(body: unknown, token = TOKEN): Request {
  return new Request("http://localhost/agent", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function makeStaticDir(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "dome-pwa-static-"));
  await writeFile(join(dir, "index.html"), "<!doctype html><title>Dome</title>", "utf8");
  await mkdir(join(dir, "assets"), { recursive: true });
  await writeFile(join(dir, "assets", "app.js"), "console.log('dome')", "utf8");
  return dir;
}

describe("createDomeHttpServer static serving", () => {
  test("GET / serves the app shell unauthenticated when staticDir is set", async () => {
    const staticDir = await makeStaticDir();
    const server = createDomeHttpServer({ vaultPath: "/tmp/unused", token: TOKEN, staticDir, agentImpl: async () => ({ answer: "", citations: [], steps: 0, stopReason: "final" }) });
    const res = await server.fetch(new Request("http://localhost/")); // NO auth header
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    expect(await res.text()).toContain("<title>Dome</title>");
  });

  test("GET /assets/* serves the asset unauthenticated", async () => {
    const staticDir = await makeStaticDir();
    const server = createDomeHttpServer({ vaultPath: "/tmp/unused", token: TOKEN, staticDir, agentImpl: async () => ({ answer: "", citations: [], steps: 0, stopReason: "final" }) });
    const res = await server.fetch(new Request("http://localhost/assets/app.js"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("dome");
  });

  test("a traversal path under /assets is rejected", async () => {
    const staticDir = await makeStaticDir();
    const server = createDomeHttpServer({ vaultPath: "/tmp/unused", token: TOKEN, staticDir, agentImpl: async () => ({ answer: "", citations: [], steps: 0, stopReason: "final" }) });
    const res = await server.fetch(new Request("http://localhost/assets/../index.html"));
    // URL normalization resolves assets/../ to / before our code sees it, so the
    // traversal attempt produces /index.html which is neither "/" nor "/assets/*"
    // — serveStatic returns null, auth gate fires (no token), 401. Also accept
    // 403/404 in case a future runtime preserves the raw path.
    expect([401, 403, 404]).toContain(res.status);
  });

  test("GET /healthz returns the ping (bearer-gated)", async () => {
    const server = createDomeHttpServer({ vaultPath: "/tmp/unused", token: TOKEN, agentImpl: async () => ({ answer: "", citations: [], steps: 0, stopReason: "final" }) });
    expect((await server.fetch(new Request("http://localhost/healthz"))).status).toBe(401); // no token
    const ok = await server.fetch(new Request("http://localhost/healthz", { headers: { authorization: `Bearer ${TOKEN}` } }));
    expect(ok.status).toBe(200);
    expect((await ok.json() as { server: string }).server).toBe("dome");
  });

  test("with no staticDir, GET / still returns the ping (back-compat)", async () => {
    const server = createDomeHttpServer({ vaultPath: "/tmp/unused", token: TOKEN, agentImpl: async () => ({ answer: "", citations: [], steps: 0, stopReason: "final" }) });
    const res = await server.fetch(new Request("http://localhost/", { headers: { authorization: `Bearer ${TOKEN}` } }));
    expect(res.status).toBe(200);
    expect((await res.json() as { server: string }).server).toBe("dome");
  });
});

describe("createDomeHttpServer", () => {
  test("POST /agent returns a synthesized answer + citations", async () => {
    const res = await server().fetch(post({ question: "what's open?" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { answer: string; citations: unknown[] };
    expect(json.answer).toContain("what's open?");
    expect(json.citations).toHaveLength(1);
  });
  test("401 without a valid bearer token", async () => {
    const res = await server().fetch(post({ question: "x" }, "wrong"));
    expect(res.status).toBe(401);
  });
  test("400 on empty question", async () => {
    const res = await server().fetch(post({ question: "  " }));
    expect(res.status).toBe(400);
  });
  test("404 on an unknown route", async () => {
    const res = await server().fetch(new Request("http://localhost/nope", { headers: { authorization: `Bearer ${TOKEN}` } }));
    expect(res.status).toBe(404);
  });
  test("413 when body exceeds maxBodyBytes (stream read, not content-length)", async () => {
    const s = createDomeHttpServer({
      vaultPath: "/tmp/unused",
      token: TOKEN,
      maxBodyBytes: 50,
      agentImpl: async (question: string, _signal: AbortSignal) => ({
        answer: `answer to: ${question}`,
        citations: [],
        steps: 1,
        stopReason: "final" as const,
      }),
    });
    // Build a body whose JSON is definitely > 50 bytes; omit content-length so
    // the stream-read path is what enforces the cap.
    const longQuestion = "x".repeat(200);
    const bodyBytes = new TextEncoder().encode(JSON.stringify({ question: longQuestion }));
    const req = new Request("http://localhost/agent", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        // Deliberately omit content-length — Bun may still set one, but the
        // assertion covers the stream-cap path regardless.
      },
      body: bodyBytes,
    });
    const res = await s.fetch(req);
    expect(res.status).toBe(413);
  });
  test("504 when ask exceeds timeoutMs", async () => {
    const s = createDomeHttpServer({
      vaultPath: "/tmp/unused",
      token: TOKEN,
      timeoutMs: 30,
      agentImpl: (_question: string, _signal: AbortSignal) => new Promise(() => {}),
    });
    const res = await s.fetch(post({ question: "will this hang?" }));
    expect(res.status).toBe(504);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("ask-timeout");
  });
  test("POST /agent includes a changes array in the JSON", async () => {
    const srv = createDomeHttpServer({
      vaultPath: "/tmp/unused",
      token: TOKEN,
      agentImpl: async (q: string) => ({
        answer: `a:${q}`,
        citations: [],
        steps: 1,
        stopReason: "final" as const,
        changes: [{ path: "wiki/made.md", kind: "create" as const }],
      }),
    });
    const res = await srv.fetch(post({ question: "make it" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { changes: { path: string; kind: string }[] };
    expect(body.changes).toEqual([{ path: "wiki/made.md", kind: "create" }]);
  });
});

// ----- POST /agent/stream -----------------------------------------------------

function streamServer(deltas: string[], stopReason: "final" | "budget" = "final") {
  return createDomeHttpServer({
    vaultPath: "/tmp/unused",
    token: TOKEN,
    agentStreamImpl: (_question: string, _signal: AbortSignal) =>
      fakeStream(deltas, stopReason),
  });
}

function postStream(body: unknown, token = TOKEN): Request {
  return new Request("http://localhost/agent/stream", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("createDomeHttpServer POST /agent/stream", () => {
  test("streams SSE text events then a final done event with citations", async () => {
    const res = await streamServer(["Hello ", "world"]).fetch(
      postStream({ question: "say hi" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const body = await res.text();
    // Each text delta is its own SSE event.
    expect(body).toContain(`data: ${JSON.stringify({ type: "text", text: "Hello " })}`);
    expect(body).toContain(`data: ${JSON.stringify({ type: "text", text: "world" })}`);
    // The final done event carries citations + stopReason.
    expect(body).toContain('"type":"done"');
    expect(body).toContain('"stopReason":"final"');
    expect(body).toContain('"path":"wiki/x.md"');
    // SSE framing: events terminated by a blank line.
    expect(body.endsWith("\n\n")).toBe(true);
  });

  test("carries stopReason=budget in the done event", async () => {
    const res = await streamServer(["partial"], "budget").fetch(
      postStream({ question: "incomplete" }),
    );
    const body = await res.text();
    expect(body).toContain('"stopReason":"budget"');
  });

  test("401 without a valid bearer token", async () => {
    const res = await streamServer(["x"]).fetch(postStream({ question: "x" }, "wrong"));
    expect(res.status).toBe(401);
  });

  test("400 on empty question", async () => {
    const res = await streamServer(["x"]).fetch(postStream({ question: "  " }));
    expect(res.status).toBe(400);
  });

  test("emits error event on timeout, not a done event, and completes in time", async () => {
    const TIMEOUT_MS = 30;
    // The fake stream yields one text delta then stalls until the abort signal
    // fires.  This exercises the timeout path without hanging indefinitely.
    const s = createDomeHttpServer({
      vaultPath: "/tmp/unused",
      token: TOKEN,
      timeoutMs: TIMEOUT_MS,
      agentStreamImpl: (_question: string, signal: AbortSignal): AgentStream => {
        async function* gen(): AsyncIterable<TextStreamPart<ToolSet>> {
          yield { type: "text-delta", id: "t1", text: "partial" } as TextStreamPart<ToolSet>;
          // Stall until the AbortController fires (timeout).
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve();
            } else {
              signal.addEventListener("abort", () => resolve(), { once: true });
            }
          });
          // Generator ends naturally after the abort — the route sees the loop
          // finish with controller.signal.aborted === true.
        }
        return {
          fullStream: gen(),
          citations: [],
          changes: [],
          finished: new Promise<{ stopReason: "budget" }>((resolve) => {
            signal.addEventListener("abort", () => resolve({ stopReason: "budget" }), { once: true });
          }),
        };
      },
    });

    const start = Date.now();
    const res = await s.fetch(postStream({ question: "will this stall?" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const body = await res.text();
    const elapsed = Date.now() - start;

    // Must have gotten the partial text event before the timeout fired.
    expect(body).toContain('"type":"text"');
    expect(body).toContain('"partial"');
    // Must have an error event mentioning the timeout — NOT a done event.
    expect(body).toContain('"type":"error"');
    expect(body).toContain(`${TIMEOUT_MS}ms`);
    expect(body).not.toContain('"type":"done"');
    // Should complete well within a couple of seconds.
    expect(elapsed).toBeLessThan(3000);
  });

  test("the streaming done event carries changes", async () => {
    const srv = createDomeHttpServer({
      vaultPath: "/tmp/unused",
      token: TOKEN,
      agentStreamImpl: (): AgentStream => ({
        fullStream: (async function* () {
          yield { type: "text-delta", id: "t", text: "ok" } as TextStreamPart<ToolSet>;
          yield { type: "finish", finishReason: "stop" } as unknown as TextStreamPart<ToolSet>;
        })(),
        citations: [],
        changes: [{ path: "wiki/seed.md", kind: "edit" }],
        finished: Promise.resolve({ stopReason: "final" as const }),
      }),
    });
    const res = await srv.fetch(new Request("http://localhost/agent/stream", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ question: "check it off" }),
    }));
    const text = await res.text();
    const doneLine = text.split("\n\n").map((b) => b.split("\n").find((l) => l.startsWith("data:"))).filter(Boolean).map((l) => JSON.parse(l!.slice(5).trim())).find((e) => e.type === "done");
    expect(doneLine).toBeDefined();
    expect(doneLine.changes).toEqual([{ path: "wiki/seed.md", kind: "edit" }]);
  });
});

// ----- POST /transcribe -------------------------------------------------

describe("POST /transcribe", () => {
  // A trivial "whisper" that ignores the audio file arg and prints a fixed transcript.
  const FAKE_WHISPER = ["sh", "-c", "cat >/dev/null; echo 'hello from whisper'"];
  function post(body: Uint8Array | null, token = TOKEN): Request {
    return new Request("http://localhost/transcribe", { method: "POST", headers: token ? { authorization: `Bearer ${token}`, "content-type": "audio/m4a" } : { "content-type": "audio/m4a" }, body });
  }
  test("transcribes audio via the configured command", async () => {
    const server = createDomeHttpServer({ vaultPath: "/tmp/unused", token: TOKEN, transcribeCommand: FAKE_WHISPER, agentImpl: async () => ({ answer: "", citations: [], steps: 0, stopReason: "final" }) });
    const res = await server.fetch(post(new Uint8Array([1, 2, 3, 4])));
    expect(res.status).toBe(200);
    const json = await res.json() as { schema: string; text: string };
    expect(json.schema).toBe("dome.transcribe/v1");
    expect(json.text).toBe("hello from whisper");
  });
  test("501 when transcribe is not configured", async () => {
    const server = createDomeHttpServer({ vaultPath: "/tmp/unused", token: TOKEN, agentImpl: async () => ({ answer: "", citations: [], steps: 0, stopReason: "final" }) });
    expect((await server.fetch(post(new Uint8Array([1, 2, 3])))).status).toBe(501);
  });
  test("400 on empty body", async () => {
    const server = createDomeHttpServer({ vaultPath: "/tmp/unused", token: TOKEN, transcribeCommand: FAKE_WHISPER, agentImpl: async () => ({ answer: "", citations: [], steps: 0, stopReason: "final" }) });
    expect((await server.fetch(post(new Uint8Array([])))).status).toBe(400);
  });
  test("401 without a token", async () => {
    const server = createDomeHttpServer({ vaultPath: "/tmp/unused", token: TOKEN, transcribeCommand: FAKE_WHISPER, agentImpl: async () => ({ answer: "", citations: [], steps: 0, stopReason: "final" }) });
    expect((await server.fetch(post(new Uint8Array([1, 2, 3]), ""))).status).toBe(401);
  });
  test("500 transcribe-timeout when the subprocess hangs past transcribeTimeoutMs", async () => {
    const HANG_CMD = ["sh", "-c", "sleep 30"];
    const server = createDomeHttpServer({
      vaultPath: "/tmp/unused",
      token: TOKEN,
      transcribeCommand: HANG_CMD,
      transcribeTimeoutMs: 50, // very short — should fire in <<1s
      agentImpl: async () => ({ answer: "", citations: [], steps: 0, stopReason: "final" }),
    });
    const start = Date.now();
    const res = await server.fetch(post(new Uint8Array([1, 2, 3, 4])));
    const elapsed = Date.now() - start;
    expect(res.status).toBe(500);
    const json = await res.json() as { error: string; message: string };
    expect(json.error).toBe("transcribe-timeout");
    expect(json.message).toContain("50ms");
    // Must not hang — should complete well within a couple of seconds.
    expect(elapsed).toBeLessThan(3000);
  });
});

describe("POST /transcribe (cloud)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  function post(body: Uint8Array | null, token = TOKEN): Request {
    return new Request("http://localhost/transcribe", { method: "POST", headers: token ? { authorization: `Bearer ${token}`, "content-type": "audio/m4a" } : { "content-type": "audio/m4a" }, body });
  }
  test("uploads to the OpenAI-compatible endpoint and returns the text", async () => {
    let url = "";
    let auth = "";
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      url = typeof input === "string" ? input : input.toString();
      auth = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify({ text: "hello cloud" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const server = createDomeHttpServer({ vaultPath: "/tmp/unused", token: TOKEN, transcribeApiKey: "sk-test", transcribeBaseUrl: "https://api.example.com/v1", transcribeModel: "whisper-1", agentImpl: async () => ({ answer: "", citations: [], steps: 0, stopReason: "final" }) });
    const res = await server.fetch(post(new Uint8Array([1, 2, 3, 4])));
    expect(res.status).toBe(200);
    expect((await res.json() as { text: string }).text).toBe("hello cloud");
    expect(url).toBe("https://api.example.com/v1/audio/transcriptions");
    expect(auth).toBe("Bearer sk-test");
  });
  test("502 transcribe-failed when the STT API rejects", async () => {
    globalThis.fetch = mock(async () => new Response("bad key", { status: 401 })) as unknown as typeof fetch;
    const server = createDomeHttpServer({ vaultPath: "/tmp/unused", token: TOKEN, transcribeApiKey: "sk-bad", agentImpl: async () => ({ answer: "", citations: [], steps: 0, stopReason: "final" }) });
    const res = await server.fetch(post(new Uint8Array([1, 2, 3, 4])));
    expect(res.status).toBe(502);
    expect((await res.json() as { error: string }).error).toBe("transcribe-failed");
  });
});
