import { describe, expect, test } from "bun:test";
import { parseSseChunk } from "../src/api/client";
import type { StreamEvent } from "../src/api/types";

describe("parseSseChunk", () => {
  test("parses complete data: frames and keeps the trailing partial", () => {
    const input = `data: ${JSON.stringify({ type: "text", text: "Hello " })}\n\n` +
                  `data: ${JSON.stringify({ type: "text", text: "world" })}\n\n` +
                  `data: {"type":"do`;
    const { events, rest } = parseSseChunk(input);
    expect(events.map((e) => (e.type === "text" ? e.text : e.type))).toEqual(["Hello ", "world"]);
    expect(rest).toBe(`data: {"type":"do`);
  });

  test("ignores blank lines and malformed frames without throwing", () => {
    const { events } = parseSseChunk(`\n\ndata: not json\n\ndata: ${JSON.stringify({ type: "done", citations: [], stopReason: "final" } as StreamEvent)}\n\n`);
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe("done");
  });
});
