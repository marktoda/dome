import { describe, expect, test } from "bun:test";
import { pad, truncate, visibleWidth, wrap } from "../../../src/cli/presenter/width";
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

describe("wrap", () => {
  test("returns a single line when within width", () => {
    expect(wrap("hello world", 20)).toEqual(["hello world"]);
  });
  test("breaks on word boundaries at the width", () => {
    expect(wrap("alpha beta gamma delta", 11)).toEqual(["alpha beta", "gamma delta"]);
  });
  test("keeps an over-long single word on its own line", () => {
    expect(wrap("supercalifragilistic word", 10)).toEqual(["supercalifragilistic", "word"]);
  });
  test("empty string yields one empty line", () => {
    expect(wrap("", 10)).toEqual([""]);
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

import { dimZeros, finding, match, signalLine, table, type Column, type Finding, type MatchView } from "../../../src/cli/presenter/primitives";

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

describe("finding", () => {
  const UNI = { color: false, unicode: true, width: 80 };
  test("renders glyph+code+subject header, what, and fix", () => {
    const f: Finding = {
      severity: "warning",
      code: "capability.grant-entry-missing",
      subject: "dome.markdown.core-size",
      what: "core.md is declared 'read' but the vault grant doesn't cover it",
      fix: "add \"core.md\" to extensions.dome.markdown.grant.read",
    };
    expect(finding(f, UNI)).toEqual([
      "  ⚠ capability.grant-entry-missing · dome.markdown.core-size",
      "      core.md is declared 'read' but the vault grant doesn't cover it",
      "      fix    add \"core.md\" to extensions.dome.markdown.grant.read",
    ]);
  });

  test("omits subject separator when no subject, and renders note before fix", () => {
    const f: Finding = {
      severity: "info",
      code: "capability.grant-starved",
      what: "'index-*.md' is not covered by the effective grant",
      note: "grant-scoped snapshots silently omit matching files",
      fix: "add the pattern under …grant.<kind>",
    };
    expect(finding(f, UNI)).toEqual([
      "  • capability.grant-starved",
      "      'index-*.md' is not covered by the effective grant",
      "      note   grant-scoped snapshots silently omit matching files",
      "      fix    add the pattern under …grant.<kind>",
    ]);
  });

  test("wraps a long what line with a hanging indent at the content column", () => {
    const narrow = { color: false, unicode: true, width: 34 };
    const f: Finding = {
      severity: "error",
      code: "x.y",
      what: "alpha beta gamma delta epsilon zeta",
    };
    expect(finding(f, narrow)).toEqual([
      "  ✗ x.y",
      "      alpha beta gamma delta",
      "      epsilon zeta",
    ]);
  });

  test("block severity renders the ✗ glyph like error", () => {
    const f: Finding = { severity: "block", code: "x.y", what: "boom" };
    expect(finding(f, UNI)).toEqual(["  ✗ x.y", "      boom"]);
  });

  test("long fix wraps with continuation lines at col 13 (not under the label)", () => {
    // width=24: textIndent = 6 + 4 + 3 = 13 spaces; avail = 24 - 13 = 11
    // "one two three four" → first chunk fits "one two" (7 ≤ 11), next word "three" would make 13 > 11
    // continuation: 13 spaces then "three four"
    const narrow = { color: false, unicode: true, width: 24 };
    const f: Finding = { severity: "error", code: "x.y", what: "boom", fix: "one two three four" };
    expect(finding(f, narrow)).toEqual([
      "  ✗ x.y",
      "      boom",
      "      fix    one two",
      "             three four",
    ]);
  });
});

describe("match", () => {
  const wide = { color: false, unicode: true, width: 60 };
  test("rank+title left, path right-aligned, breadcrumb, snippet, source ref", () => {
    const m: MatchView = {
      rank: 1,
      title: "Effect router targets",
      path: "wiki/matrices/effect-router-targets.md",
      breadcrumb: "Phase compatibility precedes capability enforcement",
      snippet: "the rejected effect is not applied",
      sourceRef: "ba1de2b · lines 46–56",
    };
    expect(match(m, wide)).toEqual([
      "  1  Effect router …  wiki/matrices/effect-router-targets.md",
      "     › Phase compatibility precedes capability enforcement",
      "     the rejected effect is not applied",
      "     ba1de2b · lines 46–56",
    ]);
  });

  test("omits breadcrumb/snippet/source lines when absent", () => {
    const m: MatchView = { rank: 2, title: "SDK surface", path: "wiki/specs/sdk-surface.md" };
    expect(match(m, wide)).toEqual([
      "  2  SDK surface                   wiki/specs/sdk-surface.md",
    ]);
  });

  test("rank 10 breadcrumb indents to match the left-column width (6 spaces)", () => {
    // left = "  10  " = 6 chars; indent must be 6 spaces to stay under the title
    const m: MatchView = {
      rank: 10,
      title: "Effect router targets",
      path: "wiki/matrices/effect-router-targets.md",
      breadcrumb: "Phase compatibility precedes capability enforcement",
    };
    const lines = match(m, wide);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const breadcrumbLine = lines[1]!;
    const leadingSpaces = breadcrumbLine.match(/^( *)/)?.[1] ?? "";
    expect(leadingSpaces).toBe("      "); // exactly 6 spaces
  });
});

const COLOR = { color: true, unicode: true, width: 80 };

describe("dimZeros", () => {
  test("joins terms with the separator and no color when color:false", () => {
    expect(dimZeros(["9 known", "0 attention", "2 partial"], ASCII)).toBe(
      "9 known · 0 attention · 2 partial",
    );
  });
  test("paints only the zero terms muted when color:true", () => {
    const out = dimZeros(["0 failed", "1 live"], COLOR);
    expect(out).toContain("1 live");
    expect(out.indexOf("1 live")).toBe(out.lastIndexOf("1 live"));
    expect(out).toContain("\x1b[");
    expect(out).toContain("0 failed");
  });
  test("treats a bare 0 and 0-prefixed counts as zero, but not 10", () => {
    expect(dimZeros(["10 known", "0"], ASCII)).toBe("10 known · 0");
  });
});

describe("signalLine", () => {
  const UNI = { color: false, unicode: true, width: 80 };
  test("glyph leads, label in an aligned column, detail follows", () => {
    // "sync" padded to 12 = "sync" + 8 spaces; then 3 spaces gap before detail
    expect(signalLine("warn", "sync", "45 pending, synced 11h ago", 12, UNI))
      .toBe("  ⚠ sync           45 pending, synced 11h ago");
  });
  test("ok tone uses the check glyph", () => {
    // "draft" padded to 12 = "draft" + 7 spaces; then 3 spaces gap before detail
    expect(signalLine("ok", "draft", "clean", 12, UNI))
      .toBe("  ✓ draft          clean");
  });
  test("empty detail omits trailing spaces", () => {
    expect(signalLine("muted", "serve", "", 12, UNI)).toBe("  ○ serve");
  });
});
