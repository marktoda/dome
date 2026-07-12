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
  test("error event ends streaming with an inline note", () => {
    let s: ChatState = { messages: [] };
    s = chatReducer(s, { kind: "assistant-start" });
    s = chatReducer(s, { kind: "event", event: { schema: AGENT_STREAM_SCHEMA, type: "error", code: "timeout", message: "timeout", retryable: true } });
    expect(s.messages[0]!.streaming).toBe(false);
    expect(s.messages[0]!.text).toContain("timeout");
  });
  test("done with changes stores them on the assistant message", () => {
    let s: ChatState = { messages: [] };
    s = chatReducer(s, { kind: "assistant-start" });
    s = chatReducer(s, { kind: "event", event: { schema: AGENT_STREAM_SCHEMA, type: "text", text: "done" } });
    s = chatReducer(s, { kind: "event", event: { schema: AGENT_STREAM_SCHEMA, type: "done", citations: [], stopReason: "final", changes: [{ path: "wiki/a.md", kind: "edit" }] } });
    expect(s.messages[0]!.changes).toEqual([{ path: "wiki/a.md", kind: "edit" }]);
  });
});
