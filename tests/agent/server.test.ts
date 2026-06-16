import { describe, expect, test } from "bun:test";
import { createAskServer } from "../../src/agent/server";
import type { AskStream } from "../../src/agent/ask";
import type { TextStreamPart, ToolSet } from "ai";

const TOKEN = "test-token";

/** Build an AskStream from a fixed list of text deltas (no model needed). */
function fakeStream(
  deltas: string[],
  stopReason: "final" | "budget" = "final",
): AskStream {
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
    finished: Promise.resolve({ stopReason }),
  };
}

function server() {
  return createAskServer({
    vaultPath: "/tmp/unused",
    token: TOKEN,
    askImpl: async (question: string, _signal: AbortSignal) => ({
      answer: `answer to: ${question}`,
      citations: [{ path: "wiki/x.md", commit: "c1" }],
      steps: 2,
      stopReason: "final" as const,
    }),
  });
}

function post(body: unknown, token = TOKEN): Request {
  return new Request("http://localhost/ask", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("createAskServer", () => {
  test("POST /ask returns a synthesized answer + citations", async () => {
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
    const s = createAskServer({
      vaultPath: "/tmp/unused",
      token: TOKEN,
      maxBodyBytes: 50,
      askImpl: async (question: string, _signal: AbortSignal) => ({
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
    const req = new Request("http://localhost/ask", {
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
    const s = createAskServer({
      vaultPath: "/tmp/unused",
      token: TOKEN,
      timeoutMs: 30,
      askImpl: (_question: string, _signal: AbortSignal) => new Promise(() => {}),
    });
    const res = await s.fetch(post({ question: "will this hang?" }));
    expect(res.status).toBe(504);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("ask-timeout");
  });
});

// ----- POST /ask/stream -----------------------------------------------------

function streamServer(deltas: string[], stopReason: "final" | "budget" = "final") {
  return createAskServer({
    vaultPath: "/tmp/unused",
    token: TOKEN,
    askStreamImpl: (_question: string, _signal: AbortSignal) =>
      fakeStream(deltas, stopReason),
  });
}

function postStream(body: unknown, token = TOKEN): Request {
  return new Request("http://localhost/ask/stream", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("createAskServer POST /ask/stream", () => {
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
});
