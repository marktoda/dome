// tests/http/agent-log.test.ts
//
// TDD test suite for the structured /agent request log.
// Step 1: failing tests written before implementation exists.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDomeHttpServer } from "../../src/http/server";
import type { AgentStream } from "../../src/agent/agent";
import type { TextStreamPart, ToolSet } from "ai";

const TOKEN = "test-token";

function tempLogPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "dome-agent-log-test-"));
  return join(dir, "agent.log");
}

// ----- Buffered /agent route -------------------------------------------------

describe("agent-log: POST /agent", () => {
  test("writes one JSON log line on success with expected fields", async () => {
    const logPath = tempLogPath();
    const srv = createDomeHttpServer({
      vaultPath: "/tmp/unused",
      token: TOKEN,
      allowWrite: true,
      agentLogPath: logPath,
      agentImpl: async (_q, _s) => ({
        answer: "done",
        citations: [],
        steps: 1,
        stopReason: "final" as const,
        changes: [{ path: "wiki/x.md", kind: "edit" as const }],
      }),
    });

    const res = await srv.fetch(
      new Request("http://localhost/agent", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ question: "check it off" }),
      }),
    );
    expect(res.status).toBe(200);

    const raw = await readFile(logPath, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]!);
    expect(entry.route).toBe("/agent");
    expect(entry.authorEnabled).toBe(true);
    expect(Array.isArray(entry.capabilities)).toBe(true);
    expect(entry.capabilities).toContain("author");
    expect(entry.changes).toEqual([{ path: "wiki/x.md", kind: "edit" }]);
    expect(entry.stopReason).toBe("final");
    expect(typeof entry.answerPreview).toBe("string");
    expect(entry.answerPreview!.length).toBeGreaterThan(0);
    expect(typeof entry.durationMs).toBe("number");
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
    expect(entry.error).toBeNull();
    expect(typeof entry.ts).toBe("string");
    expect(entry.question).toBe("check it off");
  });

  test("writes a log entry on error with stopReason null and error set", async () => {
    const logPath = tempLogPath();
    const srv = createDomeHttpServer({
      vaultPath: "/tmp/unused",
      token: TOKEN,
      agentLogPath: logPath,
      agentImpl: async () => {
        throw new Error("model exploded");
      },
    });

    const res = await srv.fetch(
      new Request("http://localhost/agent", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ question: "will fail" }),
      }),
    );
    expect(res.status).toBe(500);

    const raw = await readFile(logPath, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]!);
    expect(entry.route).toBe("/agent");
    expect(entry.stopReason).toBeNull();
    expect(entry.answerPreview).toBeNull();
    expect(entry.changes).toEqual([]);
    expect(entry.error).toBe("model exploded");
  });

  test("no-op when agentLogPath is not set (no file written, no throw)", async () => {
    const srv = createDomeHttpServer({
      vaultPath: "/tmp/unused",
      token: TOKEN,
      // No agentLogPath
      agentImpl: async (_q, _s) => ({
        answer: "silent",
        citations: [],
        steps: 1,
        stopReason: "final" as const,
        changes: [],
      }),
    });

    const res = await srv.fetch(
      new Request("http://localhost/agent", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ question: "no log" }),
      }),
    );
    // Should succeed normally — no crash
    expect(res.status).toBe(200);
  });

  test("truncates question and answerPreview to 500 chars", async () => {
    const logPath = tempLogPath();
    const longQ = "q".repeat(600);
    const longA = "a".repeat(600);
    const srv = createDomeHttpServer({
      vaultPath: "/tmp/unused",
      token: TOKEN,
      agentLogPath: logPath,
      agentImpl: async () => ({
        answer: longA,
        citations: [],
        steps: 1,
        stopReason: "final" as const,
        changes: [],
      }),
    });

    await srv.fetch(
      new Request("http://localhost/agent", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ question: longQ }),
      }),
    );

    const raw = await readFile(logPath, "utf8");
    const entry = JSON.parse(raw.trim());
    expect(entry.question.length).toBe(500);
    expect(entry.answerPreview!.length).toBe(500);
  });
});

// ----- Streaming /agent/stream route -----------------------------------------

describe("agent-log: POST /agent/stream", () => {
  test("writes one JSON log line for streaming route with changes on done", async () => {
    const logPath = tempLogPath();

    const srv = createDomeHttpServer({
      vaultPath: "/tmp/unused",
      token: TOKEN,
      allowWrite: true,
      agentLogPath: logPath,
      agentStreamImpl: (): AgentStream => ({
        fullStream: (async function* () {
          yield { type: "text-delta", id: "t", text: "streamed" } as TextStreamPart<ToolSet>;
          yield { type: "finish", finishReason: "stop" } as unknown as TextStreamPart<ToolSet>;
        })(),
        citations: [],
        changes: [{ path: "wiki/y.md", kind: "create" as const }],
        finished: Promise.resolve({ stopReason: "final" as const }),
      }),
    });

    const res = await srv.fetch(
      new Request("http://localhost/agent/stream", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ question: "stream me" }),
      }),
    );
    expect(res.status).toBe(200);
    // Drain the SSE body so the finally block runs
    await res.text();

    const raw = await readFile(logPath, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]!);
    expect(entry.route).toBe("/agent/stream");
    expect(entry.authorEnabled).toBe(true);
    expect(entry.capabilities).toContain("author");
    expect(entry.changes).toEqual([{ path: "wiki/y.md", kind: "create" }]);
    expect(entry.stopReason).toBe("final");
    expect(entry.answerPreview).toBeNull(); // stream text not buffered server-side
    expect(typeof entry.durationMs).toBe("number");
    expect(entry.error).toBeNull();
  });
});
