import { describe, expect, test } from "bun:test";
import { pad, truncate, visibleWidth } from "../../../src/cli/presenter/width";
import { headline, kv, section, statusValue } from "../../../src/cli/presenter/primitives";

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

const ASCII = { color: false, unicode: false, width: 40 };
const UNI = { color: false, unicode: true, width: 40 };

describe("statusValue", () => {
  test("glyph + label", () => {
    expect(statusValue({ tone: "warn", label: "needs attention" }, UNI))
      .toBe("⚠ needs attention");
    expect(statusValue({ tone: "ok", label: "adopted" }, ASCII))
      .toBe("√ adopted");
  });
});

describe("headline", () => {
  test("dome cmd · context left, status right-aligned to width", () => {
    // width 40: "dome status · docs" = 18, "⚠ needs attention" = 18 (⚠ is double-wide), gap = 4.
    expect(
      headline({ cmd: "status", context: "docs" }, { tone: "warn", label: "needs attention" }, UNI),
    ).toBe("dome status · docs    ⚠ needs attention");
  });

  test("omits context when absent", () => {
    expect(headline({ cmd: "doctor" }, { tone: "ok", label: "ok" }, UNI))
      .toBe(`dome doctor${" ".repeat(40 - "dome doctor".length - "✓ ok".length)}✓ ok`);
  });

  test("two-space gap fallback when status would overflow width", () => {
    const narrow = { color: false, unicode: true, width: 4 };
    expect(headline({ cmd: "status" }, { tone: "ok", label: "ok" }, narrow))
      .toBe("dome status  ✓ ok");
  });
});

describe("section", () => {
  test("ALLCAPS title, blank line before, indented body, only when body non-empty", () => {
    expect(section("At a glance", ["  sync   ok"], ASCII)).toEqual([
      "",
      "AT A GLANCE",
      "  sync   ok",
    ]);
  });
  test("empty body yields no lines", () => {
    expect(section("Diagnostics", [], ASCII)).toEqual([]);
  });
});

describe("kv", () => {
  test("aligns labels to max width, dims labels, paints values", () => {
    expect(
      kv(
        [
          { label: "sync", value: "needed", tone: "warn" },
          { label: "projection", value: "stale", tone: "warn" },
        ],
        ASCII,
      ),
    ).toEqual(["  sync         needed", "  projection   stale"]);
  });
});
