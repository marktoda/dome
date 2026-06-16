import { describe, expect, test } from "bun:test";
import { createAskServer } from "../../src/agent/server";

const TOKEN = "test-token";

function server() {
  return createAskServer({
    vaultPath: "/tmp/unused",
    token: TOKEN,
    askImpl: async (question: string) => ({
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
});
