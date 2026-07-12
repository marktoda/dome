import { describe, expect, test } from "bun:test";
import { chatReducer, type ChatState } from "../src/chat/streamReducer";
import { AGENT_STREAM_SCHEMA } from "../../contracts/agent-stream";

describe("chatReducer", () => {
  test("streams an assistant answer then finalizes with citations", () => {
    let s: ChatState = { messages: [] };
    s = chatReducer(s, { kind: "user", text: "when?" });
    s = chatReducer(s, { kind: "assistant-start" });
    s = chatReducer(s, { kind: "event", event: { schema: AGENT_STREAM_SCHEMA, type: "text", text: "July " } });
    s = chatReducer(s, { kind: "event", event: { schema: AGENT_STREAM_SCHEMA, type: "text", text: "2026" } });
    s = chatReducer(s, { kind: "event", event: { schema: AGENT_STREAM_SCHEMA, type: "done", citations: [{ path: "wiki/x.md" }], stopReason: "final" } });
    expect(s.messages).toHaveLength(2);
    const a = s.messages[1]!;
    expect(a.role).toBe("assistant");
    expect(a.text).toBe("July 2026");
    expect(a.streaming).toBe(false);
    expect(a.citations[0]!.path).toBe("wiki/x.md");
  });
  test("error event ends streaming with a structured notice", () => {
    let s: ChatState = { messages: [] };
    s = chatReducer(s, { kind: "assistant-start" });
    s = chatReducer(s, { kind: "event", event: { schema: AGENT_STREAM_SCHEMA, type: "error", code: "timeout", message: "timeout", retryable: true } });
    expect(s.messages[0]!.streaming).toBe(false);
    expect(s.messages[0]!.notice).toBe("timeout");
  });
  test("turn ids keep late events on their originating assistant message", () => {
    let s: ChatState = { messages: [] };
    s = chatReducer(s, { kind: "turn-start", turnId: "one", question: "first" });
    s = chatReducer(s, { kind: "turn-start", turnId: "two", question: "second" });
    s = chatReducer(s, { kind: "event", turnId: "one", event: { schema: AGENT_STREAM_SCHEMA, type: "text", text: "first answer" } });
    expect(s.messages[1]!.text).toBe("first answer");
    expect(s.messages[3]!.text).toBe("");
  });
  test("terminal turns ignore late stream events", () => {
    let s: ChatState = { messages: [] };
    s = chatReducer(s, { kind: "turn-start", turnId: "one", question: "first" });
    s = chatReducer(s, { kind: "event", turnId: "one", event: { schema: AGENT_STREAM_SCHEMA, type: "done", citations: [], stopReason: "final" } });
    const terminal = s;
    s = chatReducer(s, { kind: "event", turnId: "one", event: { schema: AGENT_STREAM_SCHEMA, type: "text", text: "late" } });
    expect(s).toBe(terminal);
  });
  test("explicit conversation actions append visible transcript boundaries", () => {
    let s: ChatState = { messages: [] };
    s = chatReducer(s, { kind: "boundary", text: "Retrying may repeat actions." });
    expect(s.messages[0]).toMatchObject({ role: "system", text: "Retrying may repeat actions." });
  });
  test("done with changes stores them on the assistant message", () => {
    let s: ChatState = { messages: [] };
    s = chatReducer(s, { kind: "assistant-start" });
    s = chatReducer(s, { kind: "event", event: { schema: AGENT_STREAM_SCHEMA, type: "text", text: "done" } });
    s = chatReducer(s, { kind: "event", event: { schema: AGENT_STREAM_SCHEMA, type: "done", citations: [], stopReason: "final", changes: [{ path: "wiki/a.md", kind: "edit" }] } });
    expect(s.messages[0]!.changes).toEqual([{ path: "wiki/a.md", kind: "edit" }]);
  });
});
