import { describe, expect, test } from "bun:test";

import { createAgentRuntime, type AgentRun } from "../../src/assistant/runtime";
import type { AgentMessage } from "../../src/assistant/types";

function stream(text: string): AgentRun {
  return {
    text: (async function* (): AsyncIterable<string> {
      yield text;
    })(),
    finished: Promise.resolve({
      citations: [{ path: "wiki/source.md", commit: "c1" }],
      changes: [],
      stopReason: "final",
    }),
  };
}

async function drainText(events: AsyncIterable<{ kind: string; text?: string }>): Promise<string> {
  let text = "";
  for await (const event of events) {
    if (event.kind === "text") text += event.text ?? "";
  }
  return text;
}

describe("AgentRuntime", () => {
  test("preserves prose history across turns in one session", async () => {
    const seen: Array<ReadonlyArray<AgentMessage>> = [];
    const runtime = createAgentRuntime({
      createId: () => "session-1",
      runTurn: ({ question, history }) => {
        seen.push(history);
        return stream(`answer:${question}`);
      },
    });
    const session = runtime.createSession();

    expect(await drainText(session.send("first").events)).toBe("answer:first");
    expect(await drainText(session.send("second").events)).toBe("answer:second");

    expect(seen[0]).toEqual([]);
    expect(seen[1]).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "answer:first" },
    ]);
  });

  test("isolates histories between sessions", async () => {
    let id = 0;
    const seen = new Map<string, number>();
    const runtime = createAgentRuntime({
      createId: () => `s${++id}`,
      runTurn: ({ question, history }) => {
        seen.set(question, history.length);
        return stream("ok");
      },
    });
    const one = runtime.createSession();
    const two = runtime.createSession();

    await drainText(one.send("one-a").events);
    await drainText(one.send("one-b").events);
    await drainText(two.send("two-a").events);

    expect(seen.get("one-b")).toBe(2);
    expect(seen.get("two-a")).toBe(0);
  });

  test("closed and missing sessions cannot be resumed", () => {
    const runtime = createAgentRuntime({
      createId: () => "s1",
      runTurn: () => stream("unused"),
    });
    runtime.createSession();
    expect(runtime.getSession("s1")?.id).toBe("s1");
    expect(runtime.closeSession("s1")).toBe(true);
    expect(runtime.getSession("s1")).toBeNull();
    expect(runtime.closeSession("s1")).toBe(false);
  });
});
