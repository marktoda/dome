// Structured agent-turn logging through the session-oriented AgentRuntime.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentRuntime, type AgentRun } from "../../src/assistant/runtime";
import { createDomeHttpServer } from "../../src/http/server";

const TOKEN = "test-token";
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function fakeStream(): AgentRun {
  return {
    text: (async function* (): AsyncIterable<string> {
      yield "done";
    })(),
    finished: Promise.resolve({
      citations: [{ path: "wiki/source.md", commit: "c1" }],
      changes: [{ path: "wiki/changed.md", kind: "edit" }],
      stopReason: "final",
    }),
  };
}

describe("agent session log", () => {
  test("writes one bounded JSON line per completed turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dome-agent-log-"));
    dirs.push(dir);
    const path = join(dir, "agent.jsonl");
    const runtime = createAgentRuntime({
      createId: () => "s1",
      runTurn: () => fakeStream(),
    });
    const server = createDomeHttpServer({
      vaultPath: "/tmp/unused",
      token: TOKEN,
      agentRuntime: runtime,
      agentLogPath: path,
      allowWrite: true,
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
        body: JSON.stringify({ message: "x".repeat(700) }),
      },
    ));
    await response.text();

    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(entry.route).toBe("/sessions/:id/messages");
    expect(entry.question).toBe("x".repeat(500));
    expect(entry.answerPreview).toBe("done");
    expect(entry.stopReason).toBe("final");
    expect(entry.authorEnabled).toBe(true);
    expect(entry.changes).toEqual([{ path: "wiki/changed.md", kind: "edit" }]);
  });

  test("is a no-op when no log path is configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dome-agent-log-none-"));
    dirs.push(dir);
    const runtime = createAgentRuntime({
      createId: () => "s1",
      runTurn: () => fakeStream(),
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
    await response.text();
    expect(existsSync(join(dir, "agent.jsonl"))).toBe(false);
  });
});
