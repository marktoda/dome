import { describe, expect, test } from "bun:test";
import { durationMs, relativeTime, shortOid } from "../../../src/cli/presenter/humanize";

describe("durationMs", () => {
  test("sub-second rounds to integer ms", () => {
    expect(durationMs(15.885916999999992)).toBe("16ms");
    expect(durationMs(663.356166)).toBe("663ms");
  });
  test("seconds use one decimal", () => {
    expect(durationMs(1234)).toBe("1.2s");
    expect(durationMs(59999)).toBe("60.0s");
  });
  test("null renders as a dash", () => {
    expect(durationMs(null)).toBe("-");
  });
});

describe("relativeTime", () => {
  const now = new Date("2026-06-03T15:00:00.000Z");
  test("formats minutes/hours/days ago", () => {
    expect(relativeTime("2026-06-03T14:58:00.000Z", now)).toBe("2m ago");
    expect(relativeTime("2026-06-03T13:00:00.000Z", now)).toBe("2h ago");
    expect(relativeTime("2026-06-01T15:00:00.000Z", now)).toBe("2d ago");
  });
  test("under a minute is 'just now'", () => {
    expect(relativeTime("2026-06-03T14:59:30.000Z", now)).toBe("just now");
  });
  test("null renders as a dash", () => {
    expect(relativeTime(null, now)).toBe("-");
  });
});

describe("shortOid", () => {
  test("slices to 7 chars", () => {
    expect(shortOid("733ca9d3b13d6a8577487d5b93e6c3d5e56dd6dd")).toBe("733ca9d");
  });
  test("null uses the fallback", () => {
    expect(shortOid(null, "(none)")).toBe("(none)");
  });
});
