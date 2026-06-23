import { describe, expect, test } from "bun:test";
import { captureReducer, INITIAL } from "../src/capture/captureMachine";

describe("captureReducer", () => {
  test("happy path: record → transcribe → review → file → idle", () => {
    let s = INITIAL;
    s = captureReducer(s, { kind: "start-recording" }); expect(s.phase).toBe("recording");
    s = captureReducer(s, { kind: "stop-recording" }); expect(s.phase).toBe("transcribing");
    s = captureReducer(s, { kind: "transcribed", text: "buy milk" }); expect(s.phase).toBe("review"); expect(s.draft).toBe("buy milk");
    s = captureReducer(s, { kind: "edit", text: "buy oat milk" }); expect(s.draft).toBe("buy oat milk");
    s = captureReducer(s, { kind: "file" }); expect(s.phase).toBe("filing");
    s = captureReducer(s, { kind: "filed" }); expect(s.phase).toBe("idle"); expect(s.draft).toBe("");
  });
  test("fail during transcribing returns to idle with an error", () => {
    let s = captureReducer(captureReducer(INITIAL, { kind: "start-recording" }), { kind: "stop-recording" });
    s = captureReducer(s, { kind: "fail", error: "no mic" });
    expect(s.phase).toBe("idle"); expect(s.error).toBe("no mic");
  });
  test("illegal transition is a no-op (file from idle)", () => {
    expect(captureReducer(INITIAL, { kind: "file" })).toEqual(INITIAL);
  });
});
