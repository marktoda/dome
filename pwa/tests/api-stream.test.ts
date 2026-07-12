import { describe, expect, test } from "bun:test";
import {
  AGENT_STREAM_SCHEMA,
  AgentStreamProtocolError,
  createAgentStreamDecoder,
  encodeAgentStreamEvent,
} from "../../contracts/agent-stream";

const encoder = new TextEncoder();

function frame(value: unknown, newline = "\n"): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(value)}${newline}${newline}`);
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(AgentStreamProtocolError);
    return (error as AgentStreamProtocolError).code;
  }
}

describe("agent stream contract", () => {
  test("decodes fragmented UTF-8 and LF/CRLF frames through one small Interface", () => {
    const decoder = createAgentStreamDecoder();
    const bytes = encoder.encode(
      `data: ${JSON.stringify({ schema: AGENT_STREAM_SCHEMA, type: "text", text: "Hello 🌍" })}\r\n\r\n` +
      `data: ${JSON.stringify({ schema: AGENT_STREAM_SCHEMA, type: "done", citations: [], stopReason: "final" })}\n\n`,
    );
    const events = [];
    for (let index = 0; index < bytes.length; index += 1) {
      events.push(...decoder.push(bytes.subarray(index, index + 1)));
    }
    decoder.finish();
    expect(events).toEqual([
      { schema: AGENT_STREAM_SCHEMA, type: "text", text: "Hello 🌍" },
      { schema: AGENT_STREAM_SCHEMA, type: "done", citations: [], stopReason: "final" },
    ]);
  });

  test("the server encoder emits a contract-valid terminal frame", () => {
    const decoder = createAgentStreamDecoder();
    expect(decoder.push(encodeAgentStreamEvent({
      schema: AGENT_STREAM_SCHEMA,
      type: "done",
      citations: [{ path: "wiki/source.md", snippet: "" }],
      changes: [{ path: "wiki/change.md", kind: "edit" }],
      stopReason: "budget",
    }))).toHaveLength(1);
    decoder.finish();
  });

  test("rejects malformed JSON and schema instead of silently skipping them", () => {
    const malformed = createAgentStreamDecoder();
    expect(codeOf(() => malformed.push(encoder.encode("data: not-json\n\n")))).toBe("invalid-json");

    const missingSchema = createAgentStreamDecoder();
    expect(codeOf(() => missingSchema.push(frame({ type: "error", code: "bad", message: "bad", retryable: false })))).toBe("invalid-schema");

    const unknownField = createAgentStreamDecoder();
    expect(codeOf(() => unknownField.push(frame({
      schema: AGENT_STREAM_SCHEMA,
      type: "text",
      text: "hello",
      surprise: true,
    })))).toBe("invalid-schema");
  });

  test("requires exactly one terminal and rejects every post-terminal event", () => {
    const noTerminal = createAgentStreamDecoder();
    noTerminal.push(frame({ schema: AGENT_STREAM_SCHEMA, type: "text", text: "unfinished" }));
    expect(codeOf(() => noTerminal.finish())).toBe("premature-eof");

    const duplicate = createAgentStreamDecoder();
    expect(codeOf(() => duplicate.push(encoder.encode(
      `data: ${JSON.stringify({ schema: AGENT_STREAM_SCHEMA, type: "done", citations: [], stopReason: "final" })}\n\n` +
      `data: ${JSON.stringify({ schema: AGENT_STREAM_SCHEMA, type: "error", code: "late", message: "late", retryable: false })}\n\n`,
    )))).toBe("multiple-terminal-events");

    const afterTerminal = createAgentStreamDecoder();
    afterTerminal.push(frame({ schema: AGENT_STREAM_SCHEMA, type: "error", code: "terminal", message: "terminal", retryable: false }));
    expect(codeOf(() => afterTerminal.push(frame({
      schema: AGENT_STREAM_SCHEMA,
      type: "text",
      text: "late",
    })))).toBe("event-after-terminal");
  });

  test("distinguishes a partial final frame from a clean premature EOF", () => {
    const decoder = createAgentStreamDecoder();
    decoder.push(encoder.encode(`data: {"schema":"${AGENT_STREAM_SCHEMA}","type":"done"`));
    expect(codeOf(() => decoder.finish())).toBe("partial-frame");
  });

  test("bounds individual frames and accumulated UTF-8 text", () => {
    const frameBounded = createAgentStreamDecoder({ maxFrameBytes: 32 });
    expect(codeOf(() => frameBounded.push(frame({
      schema: AGENT_STREAM_SCHEMA,
      type: "text",
      text: "larger than the tiny frame budget",
    })))).toBe("frame-too-large");

    const textBounded = createAgentStreamDecoder({ maxTextBytes: 5 });
    textBounded.push(frame({ schema: AGENT_STREAM_SCHEMA, type: "text", text: "éé" }));
    expect(codeOf(() => textBounded.push(frame({
      schema: AGENT_STREAM_SCHEMA,
      type: "text",
      text: "é",
    })))).toBe("text-too-large");
  });

  test("rejects invalid UTF-8 without replacement characters", () => {
    const decoder = createAgentStreamDecoder();
    const prefix = encoder.encode("data: ");
    const bytes = new Uint8Array(prefix.length + 3);
    bytes.set(prefix);
    bytes.set([0xc3, 0x0a, 0x0a], prefix.length);
    expect(codeOf(() => decoder.push(bytes))).toBe("invalid-utf8");
  });
});
