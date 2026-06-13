import { describe, expect, test } from "bun:test";
import { durationMs, humanizeCommand, relativeTime, shortOid, stripTrailers } from "../../../src/cli/presenter/humanize";

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

describe("humanizeCommand", () => {
  test("strips a trailing --json suffix", () => {
    expect(humanizeCommand("dome sync --json")).toBe("dome sync");
  });
  test("leaves a command without --json unchanged", () => {
    expect(humanizeCommand("dome check")).toBe("dome check");
  });
  test("only strips --json at the end, not mid-command", () => {
    expect(humanizeCommand("dome resolve q1 --json value")).toBe("dome resolve q1 --json value");
  });
});

describe("stripTrailers", () => {
  test("drops a trailing git trailer block", () => {
    const body = "Fix the thing\n\nDetails here.\n\nCo-Authored-By: Claude <x@y.z>";
    expect(stripTrailers(body)).toBe("Fix the thing\n\nDetails here.");
  });
  test("leaves a body with no trailers unchanged", () => {
    expect(stripTrailers("Just a subject\n\nA paragraph.")).toBe("Just a subject\n\nA paragraph.");
  });
  test("strips multiple stacked trailers", () => {
    const body = "Subject\n\nSigned-off-by: A <a@b>\nCo-Authored-By: B <b@c>";
    expect(stripTrailers(body)).toBe("Subject");
  });
});
