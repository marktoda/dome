import { describe, expect, test } from "bun:test";

import {
  appendBlockAnchor,
  hasBlockAnchor,
  parseBlockAnchor,
} from "../../src/core/block-anchor";

describe("parseBlockAnchor", () => {
  test("extracts a trailing ^anchor and the body without it", () => {
    const parsed = parseBlockAnchor("- [ ] ship the thing ^t1a2b3c4");
    expect(parsed).toEqual({ id: "t1a2b3c4", withoutAnchor: "- [ ] ship the thing" });
  });

  test("tolerates trailing whitespace after the anchor", () => {
    const parsed = parseBlockAnchor("- [ ] ship the thing ^t1a2b3c4   ");
    expect(parsed?.id).toBe("t1a2b3c4");
    expect(parsed?.withoutAnchor).toBe("- [ ] ship the thing");
  });

  test("returns null when there is no anchor", () => {
    expect(parseBlockAnchor("- [ ] ship the thing")).toBeNull();
  });

  test("returns null when a caret is mid-line, not a trailing block anchor", () => {
    expect(parseBlockAnchor("- [ ] use 2^10 bytes here")).toBeNull();
    expect(parseBlockAnchor("- [ ] ^mid anchor then more text")).toBeNull();
  });

  test("requires whitespace before the caret so x^y is not an anchor", () => {
    expect(parseBlockAnchor("- [ ] thing^t1a2b3c4")).toBeNull();
  });
});

describe("hasBlockAnchor", () => {
  test("is true only when a trailing anchor is present", () => {
    expect(hasBlockAnchor("- [ ] thing ^abc")).toBe(true);
    expect(hasBlockAnchor("- [ ] thing")).toBe(false);
  });
});

describe("appendBlockAnchor", () => {
  test("appends a space-separated anchor to the trimmed line", () => {
    expect(appendBlockAnchor("- [ ] ship it", "t1a2b3c4")).toBe(
      "- [ ] ship it ^t1a2b3c4",
    );
  });

  test("trims trailing whitespace before appending", () => {
    expect(appendBlockAnchor("- [ ] ship it   ", "t1a2b3c4")).toBe(
      "- [ ] ship it ^t1a2b3c4",
    );
  });

  test("round-trips with parseBlockAnchor", () => {
    const line = appendBlockAnchor("- [ ] round trip", "tdeadbeef");
    const parsed = parseBlockAnchor(line);
    expect(parsed).toEqual({ id: "tdeadbeef", withoutAnchor: "- [ ] round trip" });
  });
});
