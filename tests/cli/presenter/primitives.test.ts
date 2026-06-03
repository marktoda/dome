import { describe, expect, test } from "bun:test";
import { pad, truncate, visibleWidth } from "../../../src/cli/presenter/width";

describe("visibleWidth", () => {
  test("counts plain ASCII as length", () => {
    expect(visibleWidth("hello")).toBe(5);
  });
});

describe("pad", () => {
  test("right-pads to width", () => {
    expect(pad("ab", 5)).toBe("ab   ");
  });
  test("left-pads when align=right", () => {
    expect(pad("ab", 5, "right")).toBe("   ab");
  });
  test("never truncates a too-long string", () => {
    expect(pad("abcdef", 3)).toBe("abcdef");
  });
});

describe("truncate", () => {
  test("returns unchanged when within width", () => {
    expect(truncate("abc", 5)).toBe("abc");
  });
  test("adds an ellipsis when over width", () => {
    expect(truncate("abcdef", 5)).toBe("abcd…");
  });
  test("degrades to ... ascii ellipsis when asked", () => {
    expect(truncate("abcdef", 5, false)).toBe("ab...");
  });
});
