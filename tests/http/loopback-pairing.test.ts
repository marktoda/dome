import { describe, expect, test } from "bun:test";
import { createLoopbackPairing } from "../../src/http/loopback-pairing";

describe("loopback pairing", () => {
  test("exchanges the console code for an opaque HttpOnly session", () => {
    const pairing = createLoopbackPairing({
      code: "local-code-123",
      randomSession: () => "opaque-session",
      now: () => new Date("2026-07-11T12:00:00.000Z"),
    });
    expect(pairing.exchange("wrong-code")).toEqual({ kind: "invalid" });
    const result = pairing.exchange("local-code-123");
    expect(result).toMatchObject({ kind: "paired" });
    if (result.kind !== "paired") return;
    expect(result.cookie).toContain("dome_pair=opaque-session; HttpOnly; SameSite=Strict");
    expect(result.cookie).not.toContain("local-code-123");
    expect(pairing.authorized(new Request("http://localhost", {
      headers: { cookie: "dome_pair=opaque-session" },
    }))).toBe(true);
  });

  test("expires sessions and rate-limits repeated failures", () => {
    let time = Date.parse("2026-07-11T12:00:00.000Z");
    const pairing = createLoopbackPairing({
      code: "local-code-123",
      sessionTtlMs: 1_000,
      randomSession: () => "opaque-session",
      now: () => new Date(time),
    });
    pairing.exchange("local-code-123");
    time += 1_001;
    expect(pairing.authorized(new Request("http://localhost", {
      headers: { cookie: "dome_pair=opaque-session" },
    }))).toBe(false);
    for (let i = 0; i < 5; i += 1) expect(pairing.exchange("bad-code")).toEqual({ kind: "invalid" });
    expect(pairing.exchange("local-code-123")).toMatchObject({ kind: "limited" });
  });
});
