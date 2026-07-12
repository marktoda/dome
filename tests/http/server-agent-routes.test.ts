import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDomeHttpServer } from "../../src/http/server";
import { createAgentRuntime, type AgentDone, type AgentRun } from "../../src/assistant/runtime";
import type { AgentMessage } from "../../src/assistant/types";

const TOKEN = "test-token";

/** Build a provider-neutral agent run from fixed text deltas (no model needed). */
function fakeStream(
  deltas: string[],
  stopReason: "final" | "budget" = "final",
  changes: AgentDone["changes"] = [],
): AgentRun {
  const citations = [{ path: "wiki/x.md", commit: "c1" }];
  async function* gen(): AsyncIterable<string> {
    yield* deltas;
  }
  return {
    text: gen(),
    finished: Promise.resolve({ citations, changes, stopReason }),
  };
}

async function makeStaticDir(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "dome-pwa-static-"));
  await writeFile(join(dir, "index.html"), "<!doctype html><title>Dome</title>", "utf8");
  await mkdir(join(dir, "assets"), { recursive: true });
  await writeFile(join(dir, "assets", "app.js"), "console.log('dome')", "utf8");
  return dir;
}

test("GET / exposes granted capabilities (author only with allowWrite)", async () => {
  const ro = createDomeHttpServer({ vaultPath: "/tmp/unused", token: TOKEN });
  const roBody = (await (await ro.fetch(new Request("http://localhost/", { headers: { authorization: `Bearer ${TOKEN}` } }))).json()) as { capabilities: string[] };
  expect(roBody.capabilities).toContain("read");
  expect(roBody.capabilities).not.toContain("author");
  const rw = createDomeHttpServer({ vaultPath: "/tmp/unused", token: TOKEN, allowWrite: true });
  const rwBody = (await (await rw.fetch(new Request("http://localhost/", { headers: { authorization: `Bearer ${TOKEN}` } }))).json()) as { capabilities: string[] };
  expect(rwBody.capabilities).toContain("author");
});

describe("createDomeHttpServer static serving", () => {
  test("GET / serves the app shell unauthenticated when staticDir is set", async () => {
    const staticDir = await makeStaticDir();
    const server = createDomeHttpServer({ vaultPath: "/tmp/unused", token: TOKEN, staticDir });
    const res = await server.fetch(new Request("http://localhost/")); // NO auth header
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    expect(await res.text()).toContain("<title>Dome</title>");
  });

  test("GET /assets/* serves the asset unauthenticated", async () => {
    const staticDir = await makeStaticDir();
    const server = createDomeHttpServer({ vaultPath: "/tmp/unused", token: TOKEN, staticDir });
    const res = await server.fetch(new Request("http://localhost/assets/app.js"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("dome");
  });

  test("a traversal path under /assets is rejected", async () => {
    const staticDir = await makeStaticDir();
    const server = createDomeHttpServer({ vaultPath: "/tmp/unused", token: TOKEN, staticDir });
    const res = await server.fetch(new Request("http://localhost/assets/../index.html"));
    // URL normalization resolves assets/../ to / before our code sees it, so the
    // traversal attempt produces /index.html which is neither "/" nor "/assets/*"
    // — serveStatic returns null, auth gate fires (no token), 401. Also accept
    // 403/404 in case a future runtime preserves the raw path.
    expect([401, 403, 404]).toContain(res.status);
  });

  test("GET /healthz returns the ping (bearer-gated)", async () => {
    const server = createDomeHttpServer({ vaultPath: "/tmp/unused", token: TOKEN });
    expect((await server.fetch(new Request("http://localhost/healthz"))).status).toBe(401); // no token
    const ok = await server.fetch(new Request("http://localhost/healthz", { headers: { authorization: `Bearer ${TOKEN}` } }));
    expect(ok.status).toBe(200);
    expect((await ok.json() as { server: string }).server).toBe("dome");
  });

  test("with no staticDir, GET / still returns the ping (back-compat)", async () => {
    const server = createDomeHttpServer({ vaultPath: "/tmp/unused", token: TOKEN });
    const res = await server.fetch(new Request("http://localhost/", { headers: { authorization: `Bearer ${TOKEN}` } }));
    expect(res.status).toBe(200);
    expect((await res.json() as { server: string }).server).toBe("dome");
  });
});

describe("createDomeHttpServer loopback pairing", () => {
  test("pairs into an HttpOnly cookie that authorizes normal routes", async () => {
    const server = createDomeHttpServer({
      vaultPath: "/tmp/unused",
      token: TOKEN,
      loopbackPairing: { code: "local-code-123" },
    });
    const before = await server.fetch(new Request("http://localhost/pair/status"));
    expect(await before.json()).toEqual({
      schema: "dome.pairing/v1",
      available: true,
      paired: false,
    });
    const invalid = await server.fetch(new Request("http://localhost/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "wrong-code" }),
    }));
    expect(invalid.status).toBe(401);
    const crossOrigin = await server.fetch(new Request("http://localhost/pair", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      body: JSON.stringify({ code: "local-code-123" }),
    }));
    expect(crossOrigin.status).toBe(403);

    const paired = await server.fetch(new Request("http://localhost/pair", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({ code: "local-code-123" }),
    }));
    expect(paired.status).toBe(200);
    const setCookie = paired.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    const cookie = setCookie.split(";", 1)[0]!;
    const health = await server.fetch(new Request("http://localhost/healthz", {
      headers: { cookie },
    }));
    expect(health.status).toBe(200);
    const deniedMutation = await server.fetch(new Request("http://localhost/sessions", {
      method: "POST",
      headers: { cookie, origin: "https://attacker.example" },
    }));
    expect(deniedMutation.status).toBe(403);
  });
});

describe("createDomeHttpServer agent sessions", () => {
  test("cancels an active owned turn idempotently through the stable SSE contract", async () => {
    const runtime = createAgentRuntime({
      createId: () => "cancel-session",
      runTurn: ({ signal }) => {
        const aborted = new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve(), { once: true }));
        return {
          text: (async function* () { yield "started"; await aborted; })(),
          finished: aborted.then(() => ({ citations: [], changes: [], stopReason: "final" as const })),
        };
      },
    });
    const server = createDomeHttpServer({ vaultPath: "/tmp/unused", token: TOKEN, agentRuntime: runtime });
    const auth = { authorization: `Bearer ${TOKEN}` };
    await server.fetch(new Request("http://localhost/sessions", { method: "POST", headers: auth }));
    const stream = await server.fetch(new Request("http://localhost/sessions/cancel-session/messages", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ message: "wait" }),
    }));
    const cancelled = await server.fetch(new Request("http://localhost/sessions/cancel-session/cancel", {
      method: "POST",
      headers: auth,
    }));
    expect(await cancelled.json()).toMatchObject({ status: "cancelled", sessionId: "cancel-session" });
    const body = await stream.text();
    expect(body).toContain('"schema":"dome.agent.stream/v1"');
    expect(body).toContain('"code":"turn-cancelled"');
    const again = await server.fetch(new Request("http://localhost/sessions/cancel-session/cancel", {
      method: "POST",
      headers: auth,
    }));
    expect(await again.json()).toMatchObject({ status: "idle" });
    await server.close();
  });

  test("close aborts and drains an active streamed turn", async () => {
    let observedAbort = false;
    const runtime = createAgentRuntime({
      createId: () => "closing-session",
      runTurn: ({ signal }): AgentRun => {
        const aborted = new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => {
            observedAbort = true;
            resolve();
          }, { once: true });
        });
        return {
          text: (async function* () {
            yield "started";
            await aborted;
          })(),
          finished: aborted.then(() => ({ citations: [], changes: [], stopReason: "final" as const })),
        };
      },
    });
    const server = createDomeHttpServer({ vaultPath: "/tmp/unused", token: TOKEN, agentRuntime: runtime });
    await server.fetch(new Request("http://localhost/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    }));
    const response = await server.fetch(new Request("http://localhost/sessions/closing-session/messages", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "wait" }),
    }));

    await server.close();
    await response.text();
    expect(observedAbort).toBe(true);
  });

  test("creates a session and preserves history across streamed turns", async () => {
    const histories: Array<ReadonlyArray<AgentMessage>> = [];
    const runtime = createAgentRuntime({
      createId: () => "session-1",
      runTurn: ({ question, history }) => {
        histories.push(history);
        return fakeStream([`answer:${question}`]);
      },
    });
    const srv = createDomeHttpServer({
      vaultPath: "/tmp/unused",
      token: TOKEN,
      agentRuntime: runtime,
    });

    const created = await srv.fetch(new Request("http://localhost/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    }));
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({
      schema: "dome.agent-session/v1",
      status: "created",
      sessionId: "session-1",
    });

    const send = (message: string) => srv.fetch(new Request(
      "http://localhost/sessions/session-1/messages",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ message }),
      },
    ));
    expect(await (await send("first")).text()).toContain("answer:first");
    expect(await (await send("second")).text()).toContain("answer:second");
    expect(histories[0]).toEqual([]);
    expect(histories[1]).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "answer:first" },
    ]);
  });

  test("returns 404 for a missing session and can close an existing one", async () => {
    const runtime = createAgentRuntime({
      createId: () => "session-1",
      runTurn: () => fakeStream(["unused"]),
    });
    const srv = createDomeHttpServer({
      vaultPath: "/tmp/unused",
      token: TOKEN,
      agentRuntime: runtime,
    });
    const headers = {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    };
    const missing = await srv.fetch(new Request(
      "http://localhost/sessions/nope/messages",
      { method: "POST", headers, body: JSON.stringify({ message: "hi" }) },
    ));
    expect(missing.status).toBe(404);

    await srv.fetch(new Request("http://localhost/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    }));
    const closed = await srv.fetch(new Request(
      "http://localhost/sessions/session-1",
      { method: "DELETE", headers: { authorization: `Bearer ${TOKEN}` } },
    ));
    expect(closed.status).toBe(200);
    expect(runtime.getSession("session-1")).toBeNull();
  });

  test("session routes require the converse bearer", async () => {
    const runtime = createAgentRuntime({
      createId: () => "session-1",
      runTurn: () => fakeStream(["unused"]),
    });
    const srv = createDomeHttpServer({
      vaultPath: "/tmp/unused",
      token: TOKEN,
      agentRuntime: runtime,
    });
    const res = await srv.fetch(new Request("http://localhost/sessions", {
      method: "POST",
    }));
    expect(res.status).toBe(401);
  });

  test("streams citations, change receipts, and completion through Dome events", async () => {
    const runtime = createAgentRuntime({
      createId: () => "s1",
      runTurn: () => fakeStream(
        ["Hello ", "world"],
        "final",
        [{ path: "wiki/changed.md", kind: "edit" }],
      ),
    });
    const server = createDomeHttpServer({
      vaultPath: "/tmp/unused",
      token: TOKEN,
      agentRuntime: runtime,
    });
    await server.fetch(new Request("http://localhost/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    }));
    const response = await server.fetch(new Request(
      "http://localhost/sessions/s1/messages",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: "hi" }),
      },
    ));
    const body = await response.text();
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(body).toContain('"type":"text","text":"Hello "');
    expect(body).toContain('"type":"done"');
    expect(body).toContain('"path":"wiki/x.md"');
    expect(body).toContain('"path":"wiki/changed.md"');
    expect(body.endsWith("\n\n")).toBe(true);
  });

  test("rejects empty and oversized messages before starting a turn", async () => {
    const runtime = createAgentRuntime({
      createId: () => "s1",
      runTurn: () => fakeStream(["unused"]),
    });
    const server = createDomeHttpServer({
      vaultPath: "/tmp/unused",
      token: TOKEN,
      maxBodyBytes: 50,
      agentRuntime: runtime,
    });
    await server.fetch(new Request("http://localhost/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    }));
    const headers = {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    };
    const empty = await server.fetch(new Request(
      "http://localhost/sessions/s1/messages",
      { method: "POST", headers, body: JSON.stringify({ message: " " }) },
    ));
    expect(empty.status).toBe(400);
    const oversized = await server.fetch(new Request(
      "http://localhost/sessions/s1/messages",
      { method: "POST", headers, body: JSON.stringify({ message: "x".repeat(200) }) },
    ));
    expect(oversized.status).toBe(413);
  });

  test("emits a timeout error event and no completion", async () => {
    const timeoutMs = 30;
    const runtime = createAgentRuntime({
      createId: () => "s1",
      runTurn: ({ signal }) => ({
        text: (async function* (): AsyncIterable<string> {
          yield "partial";
          await new Promise<void>((resolve) => {
            if (signal?.aborted === true) resolve();
            else signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        })(),
        finished: Promise.resolve({
          citations: [],
          changes: [],
          stopReason: "budget" as const,
        }),
      }),
    });
    const server = createDomeHttpServer({
      vaultPath: "/tmp/unused",
      token: TOKEN,
      timeoutMs,
      agentRuntime: runtime,
    });
    await server.fetch(new Request("http://localhost/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    }));
    const response = await server.fetch(new Request(
      "http://localhost/sessions/s1/messages",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: "hang" }),
      },
    ));
    const body = await response.text();
    expect(body).toContain('"type":"text"');
    expect(body).toContain('"type":"error"');
    expect(body).toContain('"code":"turn-timeout"');
    expect(body).toContain(`${timeoutMs}ms`);
    expect(body).not.toContain('"type":"done"');
  });

  test("legacy single-turn agent routes are removed", async () => {
    const server = createDomeHttpServer({ vaultPath: "/tmp/unused", token: TOKEN });
    for (const path of ["/agent", "/agent/stream"]) {
      const response = await server.fetch(new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
      }));
      expect(response.status).toBe(404);
    }
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
    const server = createDomeHttpServer({ vaultPath: "/tmp/unused", token: TOKEN, transcribeCommand: FAKE_WHISPER });
    const res = await server.fetch(post(new Uint8Array([1, 2, 3, 4])));
    expect(res.status).toBe(200);
    const json = await res.json() as { schema: string; text: string };
    expect(json.schema).toBe("dome.transcribe/v1");
    expect(json.text).toBe("hello from whisper");
  });
  test("501 when transcribe is not configured", async () => {
    const server = createDomeHttpServer({ vaultPath: "/tmp/unused", token: TOKEN });
    expect((await server.fetch(post(new Uint8Array([1, 2, 3])))).status).toBe(501);
  });
  test("400 on empty body", async () => {
    const server = createDomeHttpServer({ vaultPath: "/tmp/unused", token: TOKEN, transcribeCommand: FAKE_WHISPER });
    expect((await server.fetch(post(new Uint8Array([])))).status).toBe(400);
  });
  test("401 without a token", async () => {
    const server = createDomeHttpServer({ vaultPath: "/tmp/unused", token: TOKEN, transcribeCommand: FAKE_WHISPER });
    expect((await server.fetch(post(new Uint8Array([1, 2, 3]), ""))).status).toBe(401);
  });
  test("500 transcribe-timeout when the subprocess hangs past transcribeTimeoutMs", async () => {
    const HANG_CMD = ["sh", "-c", "sleep 30"];
    const server = createDomeHttpServer({
      vaultPath: "/tmp/unused",
      token: TOKEN,
      transcribeCommand: HANG_CMD,
      transcribeTimeoutMs: 50, // very short — should fire in <<1s
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
    const server = createDomeHttpServer({ vaultPath: "/tmp/unused", token: TOKEN, transcribeApiKey: "sk-test", transcribeBaseUrl: "https://api.example.com/v1", transcribeModel: "whisper-1" });
    const res = await server.fetch(post(new Uint8Array([1, 2, 3, 4])));
    expect(res.status).toBe(200);
    expect((await res.json() as { text: string }).text).toBe("hello cloud");
    expect(url).toBe("https://api.example.com/v1/audio/transcriptions");
    expect(auth).toBe("Bearer sk-test");
  });
  test("502 transcribe-failed when the STT API rejects", async () => {
    globalThis.fetch = mock(async () => new Response("bad key", { status: 401 })) as unknown as typeof fetch;
    const server = createDomeHttpServer({ vaultPath: "/tmp/unused", token: TOKEN, transcribeApiKey: "sk-bad" });
    const res = await server.fetch(post(new Uint8Array([1, 2, 3, 4])));
    expect(res.status).toBe(502);
    expect((await res.json() as { error: string }).error).toBe("transcribe-failed");
  });
});
