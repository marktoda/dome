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
  test("ALLCAPS title at indent 2, body bumped 2, only when body non-empty", () => {
    expect(section("At a glance", ["  sync   ok"], ASCII)).toEqual([
      "",
      "  AT A GLANCE",
      "    sync   ok",
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

import { bullets, footer, nextActions, rule } from "../../../src/cli/presenter/primitives";

describe("rule", () => {
  test("fills width with the line char", () => {
    expect(rule({ color: false, unicode: true, width: 10 })).toBe("──────────");
    expect(rule({ color: false, unicode: false, width: 10 })).toBe("----------");
  });
});

describe("footer", () => {
  test("rule line then glyph + message", () => {
    expect(footer({ tone: "warn", label: "1 action needed → dome sync" }, { color: false, unicode: true, width: 12 }))
      .toEqual(["", "────────────", "⚠ 1 action needed → dome sync"]);
  });
});

describe("bullets", () => {
  test("dash bullets, or an empty marker", () => {
    expect(bullets(["a", "b"], ASCII)).toEqual(["  - a", "  - b"]);
    expect(bullets([], ASCII, "none")).toEqual(["  none"]);
  });
});

describe("nextActions", () => {
  test("pointer + command + description", () => {
    expect(
      nextActions([{ command: "dome sync", description: "adopt pending commits" }], UNI),
    ).toEqual(["  → dome sync   adopt pending commits"]);
  });
  test("empty list yields no lines", () => {
    expect(nextActions([], UNI)).toEqual([]);
  });
});

import { tree } from "../../../src/cli/presenter/primitives";

describe("tree", () => {
  test("├─ for non-last, └─ for last", () => {
    expect(
      tree(
        [
          { label: "a", lines: [] },
          { label: "b", lines: ["detail"] },
        ],
        ASCII,
      ),
    ).toEqual(["  |- a", "  `- b", "       detail"]);
  });
  test("unicode connectors", () => {
    expect(tree([{ label: "x", lines: [] }], UNI)).toEqual(["  └─ x"]);
  });
});

import { table, type Column } from "../../../src/cli/presenter/primitives";

type Row = { name: string; phase: string };
const COLS: Column<Row>[] = [
  { header: "PROCESSOR", get: (r) => ({ text: r.name }), priority: 1 },
  { header: "PHASE", get: (r) => ({ text: r.phase }), priority: 2 },
];

describe("table", () => {
  test("headers + aligned columns, no trailing whitespace on the last column", () => {
    const rows: Row[] = [
      { name: "dome.graph.links", phase: "adoption" },
      { name: "dome.daily.today", phase: "view" },
    ];
    expect(table(rows, COLS, { color: false, unicode: true, width: 80 })).toEqual([
      "  PROCESSOR         PHASE",
      "  dome.graph.links  adoption",
      "  dome.daily.today  view",
    ]);
  });

  test("truncates the widest cell when over width, fitting the terminal", () => {
    const rows: Row[] = [{ name: "a".repeat(40), phase: "adoption" }];
    const lines = table(rows, COLS, { color: false, unicode: true, width: 24 });
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(24);
    expect(lines[1]).toContain("…");
  });

  test("empty rows render a muted placeholder", () => {
    expect(table([], COLS, ASCII)).toEqual(["  (no rows)"]);
  });

  test("does not drop columns under extreme width pressure (may exceed width)", () => {
    type R3 = { a: string; b: string; c: string };
    const cols: Column<R3>[] = [
      { header: "A", get: (r) => ({ text: r.a }), priority: 1 },
      { header: "B", get: (r) => ({ text: r.b }), priority: 2 },
      { header: "C", get: (r) => ({ text: r.c }), priority: 3 },
    ];
    const lines = table([{ a: "xxxx", b: "yyyy", c: "zzzz" }], cols, { color: false, unicode: true, width: 10 });
    // header + 1 body row; all three columns survive (no dropping in v1).
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("A");
    expect(lines[0]).toContain("C");
  });
});
