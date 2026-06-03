# CLI Presenter Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Dome CLI's ad-hoc human-output formatting with a shared, pure presenter layer that renders each command's existing structured result into polished-minimal terminal output (ALLCAPS-dim headers, status glyphs, width-fit tables), auto-degrading on non-TTY/`NO_COLOR`.

**Architecture:** A new `src/cli/presenter/` package exposes (1) `resolveCaps` — the single environment read producing `{ color, unicode, width }`; (2) a `theme` of tone→color and glyph maps keyed on caps; (3) pure layout `primitives` (headline, section, kv, table, rule, tree, footer) that take `caps` and return strings. Commands keep computing their structured result and call a per-command `render*(result, caps)` instead of the current `human-output`/`format` helpers. `--json` is unchanged. The brittle regex status-classifier in `human-output.ts` is deleted; tone now travels on the data.

**Tech Stack:** TypeScript on Bun, Commander, `picocolors` (existing). One new runtime dependency: `string-width` (ANSI/CJK-correct width for alignment). Glyphs and truncation are hand-rolled (not `figures`/`cli-truncate`) so behavior is a pure function of injected `caps` — see Task 0 note.

---

## Design source

Spec: `docs/superpowers/specs/2026-06-03-cli-presenter-design.md`. Read it before starting.

## Dependency-list refinement vs. the spec (read this)

The spec §Dependencies listed `string-width`, `cli-truncate`, `wrap-ansi`, and `figures`. This plan tightens that to **`string-width` only**, hand-rolling glyphs and truncation:

- **Glyphs:** a 7-entry unicode/ASCII map keyed on `caps.unicode` is trivial and, crucially, deterministic under injected `caps`. `figures` auto-detects the platform at import time, which fights the "pass `{unicode:false}` and assert exact ASCII" test model. Hand-roll wins on testability.
- **Truncation:** done on **plain (uncolored) strings** before `paint()` wraps them in ANSI, so a simple `string-width`-based slice is enough; `cli-truncate` adds nothing.
- **Wrapping (`wrap-ansi`):** not needed in v1 — long descriptions are truncated with `…`, not wrapped.
- **`string-width` is kept** because paths/titles can contain non-ASCII and `.length` miscounts CJK/emoji width.

If you disagree with dropping `figures`, that is the one place to revisit — everything else follows from it.

## File structure

```
src/cli/presenter/
  caps.ts          resolveCaps(stream) → Caps; Caps type                    [Task 1]
  theme.ts         Tone, GlyphName, glyph(), paint(), statusGlyph()         [Task 2]
  humanize.ts      relativeTime(), durationMs(), shortOid(), count()        [Task 3]
  primitives.ts    headline, section, kv, statusValue, rule, bullets,
                   nextActions, footer, tree, table, Column<R>              [Tasks 4–9]
  index.ts         barrel re-export of the above                           [Task 10]

src/cli/
  human-output.ts  DELETE regex classifier; keep nothing the presenter replaces  [Task 16]
  format.ts        DELETE formatTable (replaced by presenter table)             [Task 14]
  commands/status.ts   renderStatus(result, caps)                          [Task 12]
  commands/check.ts    renderCheck(result, caps)                           [Task 13]
  commands/inspect.ts  per-subject Column<R> specs + renderInspect         [Task 14]
  commands/{sync,serve,lint,doctor,query,init,resolve,answer,rebuild,run}.ts
                       render* per command                                 [Tasks 15–18]

tests/cli/presenter/
  caps.test.ts, theme.test.ts, humanize.test.ts, primitives.test.ts        [Tasks 1–9]
```

**Test fixture used everywhere:** `const ASCII: Caps = { color: false, unicode: false, width: 80 }` and `const UNI: Caps = { color: false, unicode: true, width: 80 }`. Tests assert against `color:false` so assertions hold plain text; a dedicated Task 2 test covers `color:true`.

---

## PHASE 1 — Presenter foundation (no command behavior changes)

### Task 1: `Caps` + `resolveCaps`

**Files:**
- Create: `src/cli/presenter/caps.ts`
- Test: `tests/cli/presenter/caps.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { resolveCaps } from "../../../src/cli/presenter/caps";

describe("resolveCaps", () => {
  const base = { isTTY: true, columns: 120 };

  test("TTY with no NO_COLOR enables color and uses columns", () => {
    const caps = resolveCaps(base, {});
    expect(caps.color).toBe(true);
    expect(caps.width).toBe(120);
  });

  test("NO_COLOR disables color even on a TTY", () => {
    const caps = resolveCaps(base, { NO_COLOR: "1" });
    expect(caps.color).toBe(false);
  });

  test("FORCE_COLOR enables color when not a TTY", () => {
    const caps = resolveCaps({ isTTY: false }, { FORCE_COLOR: "1" });
    expect(caps.color).toBe(true);
  });

  test("non-TTY without FORCE_COLOR disables color and falls back to width 80", () => {
    const caps = resolveCaps({ isTTY: false }, {});
    expect(caps.color).toBe(false);
    expect(caps.width).toBe(80);
  });

  test("unicode requires a TTY and a UTF locale", () => {
    expect(resolveCaps(base, { LANG: "en_US.UTF-8" }).unicode).toBe(true);
    expect(resolveCaps(base, { LANG: "C" }).unicode).toBe(false);
    expect(resolveCaps({ isTTY: false, columns: 120 }, { LANG: "en_US.UTF-8" }).unicode).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/presenter/caps.test.ts`
Expected: FAIL — `Cannot find module '.../caps'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/cli/presenter/caps.ts
//
// The single environment read for CLI human output. Every presenter
// primitive is a pure function of the returned Caps — no primitive reads
// process.env or process.stdout directly. Tests inject Caps to assert
// exact output.

export type Caps = {
  readonly color: boolean;
  readonly unicode: boolean;
  readonly width: number;
};

type OutStream = { readonly isTTY?: boolean; readonly columns?: number };

const DEFAULT_WIDTH = 80;

function isForceColor(env: Record<string, string | undefined>): boolean {
  const v = env.FORCE_COLOR;
  return v !== undefined && v.length > 0 && v !== "0" && v.toLowerCase() !== "false";
}

function isUtfLocale(env: Record<string, string | undefined>): boolean {
  const locale = env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? "";
  return /utf-?8/i.test(locale);
}

/**
 * Resolve output capabilities from a stream + environment. `--json` callers
 * never reach this — they serialize and return before rendering.
 *
 * Precedence for color: NO_COLOR (off) > FORCE_COLOR (on) > stream.isTTY.
 */
export function resolveCaps(
  stream: OutStream = process.stdout,
  env: Record<string, string | undefined> = process.env,
): Caps {
  const color =
    env.NO_COLOR !== undefined ? false : isForceColor(env) ? true : stream.isTTY === true;
  const unicode = stream.isTTY === true && isUtfLocale(env);
  const width =
    typeof stream.columns === "number" && stream.columns > 0 ? stream.columns : DEFAULT_WIDTH;
  return { color, unicode, width };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/cli/presenter/caps.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli/presenter/caps.ts tests/cli/presenter/caps.test.ts
git commit -m "feat(cli): add resolveCaps capability resolution for presenter"
```

---

### Task 2: `theme` — tone→color and glyph maps

**Files:**
- Create: `src/cli/presenter/theme.ts`
- Test: `tests/cli/presenter/theme.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { glyph, paint, statusGlyph, type Tone } from "../../../src/cli/presenter/theme";

const ASCII = { color: false, unicode: false, width: 80 };
const UNI = { color: false, unicode: true, width: 80 };
const COLOR_UNI = { color: true, unicode: true, width: 80 };

describe("glyph", () => {
  test("unicode caps emit unicode glyphs", () => {
    expect(glyph("ok", UNI)).toBe("✓");
    expect(glyph("err", UNI)).toBe("✗");
    expect(glyph("warn", UNI)).toBe("⚠");
    expect(glyph("pending", UNI)).toBe("○");
    expect(glyph("pointer", UNI)).toBe("→");
    expect(glyph("sep", UNI)).toBe("·");
  });
  test("ascii caps emit ascii fallbacks", () => {
    expect(glyph("ok", ASCII)).toBe("√");
    expect(glyph("err", ASCII)).toBe("x");
    expect(glyph("warn", ASCII)).toBe("!");
    expect(glyph("pointer", ASCII)).toBe(">");
    expect(glyph("sep", ASCII)).toBe("-");
  });
});

describe("paint", () => {
  test("color:false returns text unchanged", () => {
    expect(paint("hi", "ok", ASCII)).toBe("hi");
  });
  test("color:true wraps with ANSI for a hued tone", () => {
    const out = paint("hi", "ok", COLOR_UNI);
    expect(out).not.toBe("hi");
    expect(out).toContain("hi");
    expect(out).toContain("["); // contains an ANSI escape
  });
  test("plain tone is never colored", () => {
    expect(paint("hi", "plain", COLOR_UNI)).toBe("hi");
  });
});

describe("statusGlyph", () => {
  test("maps tone to its status glyph name", () => {
    expect(statusGlyph("ok", UNI)).toBe("✓");
    expect(statusGlyph("warn", UNI)).toBe("⚠");
    expect(statusGlyph("err", UNI)).toBe("✗");
    expect(statusGlyph("muted", UNI)).toBe("○");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/presenter/theme.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/cli/presenter/theme.ts
import pc from "picocolors";

import type { Caps } from "./caps";

export type Tone = "ok" | "warn" | "err" | "info" | "muted" | "ident" | "plain";
export type GlyphName = "ok" | "err" | "warn" | "pending" | "pointer" | "sep" | "bullet";

const UNICODE: Record<GlyphName, string> = {
  ok: "✓",
  err: "✗",
  warn: "⚠",
  pending: "○",
  pointer: "→",
  sep: "·",
  bullet: "•",
};

const ASCII: Record<GlyphName, string> = {
  ok: "√",
  err: "x",
  warn: "!",
  pending: "o",
  pointer: ">",
  sep: "-",
  bullet: "*",
};

export function glyph(name: GlyphName, caps: Caps): string {
  return (caps.unicode ? UNICODE : ASCII)[name];
}

export function paint(text: string, tone: Tone, caps: Caps): string {
  if (!caps.color || tone === "plain") return text;
  switch (tone) {
    case "ok":
      return pc.green(text);
    case "warn":
      return pc.yellow(text);
    case "err":
      return pc.red(text);
    case "info":
      return pc.cyan(text);
    case "ident":
      return pc.cyan(text);
    case "muted":
      return pc.dim(text);
  }
}

const TONE_GLYPH: Record<Tone, GlyphName> = {
  ok: "ok",
  warn: "warn",
  err: "err",
  info: "bullet",
  muted: "pending",
  ident: "bullet",
  plain: "bullet",
};

export function statusGlyph(tone: Tone, caps: Caps): string {
  return glyph(TONE_GLYPH[tone], caps);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/cli/presenter/theme.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/presenter/theme.ts tests/cli/presenter/theme.test.ts
git commit -m "feat(cli): add presenter theme (tone colors + glyph maps)"
```

---

### Task 3: `humanize` — cell formatters

**Files:**
- Create: `src/cli/presenter/humanize.ts`
- Test: `tests/cli/presenter/humanize.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/presenter/humanize.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/cli/presenter/humanize.ts
//
// Cell formatters that turn machine values into human-scannable text.
// Pure; `relativeTime` takes `now` explicitly so it is deterministic in tests.

export function durationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function relativeTime(
  iso: string | null | undefined,
  now: Date = new Date(),
): string {
  if (iso === null || iso === undefined) return "-";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "-";
  const deltaSec = Math.round((now.getTime() - then) / 1000);
  if (deltaSec < 60) return "just now";
  const min = Math.round(deltaSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

export function shortOid(oid: string | null | undefined, fallback = "none"): string {
  return oid === null || oid === undefined ? fallback : oid.slice(0, 7);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/cli/presenter/humanize.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/presenter/humanize.ts tests/cli/presenter/humanize.test.ts
git commit -m "feat(cli): add presenter humanize cell formatters"
```

---

### Task 4: install `string-width` + width helper

**Files:**
- Modify: `package.json` (add dependency)
- Create: `src/cli/presenter/width.ts`
- Test: `tests/cli/presenter/primitives.test.ts` (start the file here)

- [ ] **Step 1: Add the dependency**

Run: `bun add string-width@^7`
Expected: `package.json` gains `"string-width": "^7.x"` under `dependencies`.

- [ ] **Step 2: Verify the dependency fence still passes**

Run: `bun test tests/integration/bundle-deps.test.ts`
Expected: PASS. (`string-width` is imported only under `src/cli`, never from `src/index.ts`. If this fails, stop — do not import the presenter from `src/index.ts`.)

- [ ] **Step 3: Write the failing test**

```ts
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
```

- [ ] **Step 4: Run test to verify it fails**

Run: `bun test tests/cli/presenter/primitives.test.ts`
Expected: FAIL — `width` module not found.

- [ ] **Step 5: Write minimal implementation**

```ts
// src/cli/presenter/width.ts
import stringWidth from "string-width";

export function visibleWidth(text: string): number {
  return stringWidth(text);
}

export function pad(text: string, width: number, align: "left" | "right" = "left"): string {
  const gap = width - visibleWidth(text);
  if (gap <= 0) return text;
  const fill = " ".repeat(gap);
  return align === "right" ? fill + text : text + fill;
}

/**
 * Truncate to a visible width, appending an ellipsis. `unicode` picks the
 * single-char "…" (true) vs "..." (false). Operates on plain (uncolored)
 * text — call before paint().
 */
export function truncate(text: string, width: number, unicode = true): string {
  if (visibleWidth(text) <= width) return text;
  const ell = unicode ? "…" : "...";
  const budget = Math.max(0, width - ell.length);
  // ASCII/codepoint slice is sufficient here; cells are plain text.
  let out = "";
  for (const ch of text) {
    if (visibleWidth(out + ch) > budget) break;
    out += ch;
  }
  return out + ell;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/cli/presenter/primitives.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock src/cli/presenter/width.ts tests/cli/presenter/primitives.test.ts
git commit -m "feat(cli): add string-width-backed pad/truncate helpers"
```

---

### Task 5: `headline` + `statusValue` primitives

**Files:**
- Create: `src/cli/presenter/primitives.ts`
- Test: append to `tests/cli/presenter/primitives.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```ts
import { headline, statusValue } from "../../../src/cli/presenter/primitives";

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
    // width 40: "dome status · docs" = 18 chars, "⚠ needs attention" = 17,
    // gap = 40 - 18 - 17 = 5 spaces.
    expect(
      headline(
        { cmd: "status", context: "docs" },
        { tone: "warn", label: "needs attention" },
        UNI,
      ),
    ).toBe("dome status · docs     ⚠ needs attention");
  });

  test("omits context when absent", () => {
    expect(
      headline({ cmd: "doctor" }, { tone: "ok", label: "ok" }, UNI),
    ).toBe(`dome doctor${" ".repeat(40 - "dome doctor".length - "✓ ok".length)}✓ ok`);
  });

  test("two-space gap fallback when status would overflow width", () => {
    const narrow = { color: false, unicode: true, width: 4 };
    expect(headline({ cmd: "status" }, { tone: "ok", label: "ok" }, narrow))
      .toBe("dome status  ✓ ok");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/presenter/primitives.test.ts`
Expected: FAIL — `headline`/`statusValue` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/cli/presenter/primitives.ts
import pc from "picocolors";

import type { Caps } from "./caps";
import { glyph, paint, statusGlyph, type Tone } from "./theme";
import { pad, truncate, visibleWidth } from "./width";

export type Status = { readonly tone: Tone; readonly label: string };

export function statusValue(status: Status, caps: Caps): string {
  const g = statusGlyph(status.tone, caps);
  return `${g} ${paint(status.label, status.tone, caps)}`;
}

export function headline(
  left: { readonly cmd: string; readonly context?: string },
  status: Status,
  caps: Caps,
): string {
  const sep = glyph("sep", caps);
  const leftPlain =
    left.context !== undefined ? `dome ${left.cmd} ${sep} ${left.context}` : `dome ${left.cmd}`;
  // Color: dim "dome", bold cmd. Keep plain for width math.
  const leftStyled = caps.color
    ? leftPlain.replace(`dome ${left.cmd}`, `${paint("dome", "muted", caps)} ${bold(left.cmd, caps)}`)
    : leftPlain;
  const right = statusValue(status, caps);
  const rightPlain = `${statusGlyph(status.tone, caps)} ${status.label}`;
  const gap = caps.width - visibleWidth(leftPlain) - visibleWidth(rightPlain);
  const spacer = gap >= 1 ? " ".repeat(gap) : "  ";
  return `${leftStyled}${spacer}${right}`;
}

function bold(text: string, caps: Caps): string {
  return caps.color ? pc.bold(text) : text;
}
```

Note: `bold` returns text unchanged when `caps.color` is false, so the `color:false` headline tests assert plain text. Width math always uses `leftPlain`/`rightPlain`, never the styled strings, so ANSI codes never corrupt alignment.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/cli/presenter/primitives.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/presenter/primitives.ts tests/cli/presenter/primitives.test.ts
git commit -m "feat(cli): add headline + statusValue primitives"
```

---

### Task 6: `section` + `kv` primitives

**Files:**
- Modify: `src/cli/presenter/primitives.ts`
- Test: append to `tests/cli/presenter/primitives.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```ts
import { kv, section } from "../../../src/cli/presenter/primitives";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/presenter/primitives.test.ts`
Expected: FAIL — `section`/`kv` not exported.

- [ ] **Step 3: Write minimal implementation (append to primitives.ts)**

```ts
export function section(
  title: string,
  body: ReadonlyArray<string>,
  caps: Caps,
): ReadonlyArray<string> {
  if (body.length === 0) return [];
  return ["", paint(title.toUpperCase(), "muted", caps), ...body];
}

export type KvRow = { readonly label: string; readonly value: string; readonly tone?: Tone };

export function kv(rows: ReadonlyArray<KvRow>, caps: Caps): ReadonlyArray<string> {
  const labelWidth = rows.reduce((m, r) => Math.max(m, visibleWidth(r.label)), 0);
  return rows.map((r) => {
    const label = paint(pad(r.label, labelWidth), "muted", caps);
    const value = paint(r.value, r.tone ?? "plain", caps);
    return `  ${label}   ${value}`;
  });
}
```

(`color:false` makes `paint` a no-op, so `kv` returns `"  " + paddedLabel + "   " + value`; the test's expected spacing matches: 2 + 10 + 3 = `"  sync         needed"`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/cli/presenter/primitives.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/presenter/primitives.ts tests/cli/presenter/primitives.test.ts
git commit -m "feat(cli): add section + kv primitives"
```

---

### Task 7: `rule`, `footer`, `bullets`, `nextActions` primitives

**Files:**
- Modify: `src/cli/presenter/primitives.ts`
- Test: append to `tests/cli/presenter/primitives.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/presenter/primitives.test.ts`
Expected: FAIL — symbols not exported.

- [ ] **Step 3: Write minimal implementation (append to primitives.ts)**

```ts
export function rule(caps: Caps, label?: string): string {
  const ch = caps.unicode ? "─" : "-";
  const line = ch.repeat(Math.max(0, caps.width));
  const text = label === undefined ? line : `${ch}${ch} ${label} ${ch.repeat(Math.max(0, caps.width - label.length - 4))}`;
  return paint(text, "muted", caps);
}

export function footer(status: Status, caps: Caps): ReadonlyArray<string> {
  return ["", rule(caps), statusValue(status, caps)];
}

export function bullets(
  items: ReadonlyArray<string>,
  caps: Caps,
  empty = "none",
): ReadonlyArray<string> {
  if (items.length === 0) return [`  ${paint(empty, "muted", caps)}`];
  return items.map((it) => `  - ${it}`);
}

export type NextAction = { readonly command: string | null; readonly description: string };

export function nextActions(
  actions: ReadonlyArray<NextAction>,
  caps: Caps,
): ReadonlyArray<string> {
  return actions.map((a) => {
    const cmd = paint(a.command ?? "manual", "ident", caps);
    return `  ${glyph("pointer", caps)} ${cmd}   ${a.description}`;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/cli/presenter/primitives.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/presenter/primitives.ts tests/cli/presenter/primitives.test.ts
git commit -m "feat(cli): add rule, footer, bullets, nextActions primitives"
```

---

### Task 8: `tree` primitive (for loop / nested status)

**Files:**
- Modify: `src/cli/presenter/primitives.ts`
- Test: append to `tests/cli/presenter/primitives.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/presenter/primitives.test.ts`
Expected: FAIL — `tree` not exported.

- [ ] **Step 3: Write minimal implementation (append)**

```ts
export type TreeNode = { readonly label: string; readonly lines: ReadonlyArray<string> };

export function tree(nodes: ReadonlyArray<TreeNode>, caps: Caps): ReadonlyArray<string> {
  const tee = caps.unicode ? "├─" : "|-";
  const elbow = caps.unicode ? "└─" : "`-";
  const out: string[] = [];
  nodes.forEach((node, i) => {
    const connector = i === nodes.length - 1 ? elbow : tee;
    out.push(`  ${connector} ${node.label}`);
    for (const line of node.lines) out.push(`       ${line}`);
  });
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/cli/presenter/primitives.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/presenter/primitives.ts tests/cli/presenter/primitives.test.ts
git commit -m "feat(cli): add tree primitive"
```

---

### Task 9: `table` primitive — curated columns, width-fit

**Files:**
- Modify: `src/cli/presenter/primitives.ts`
- Test: append to `tests/cli/presenter/primitives.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```ts
import { table, type Column } from "../../../src/cli/presenter/primitives";

type Row = { name: string; phase: string };
const COLS: Column<Row>[] = [
  { header: "PROCESSOR", get: (r) => ({ text: r.name }), priority: 1 },
  { header: "PHASE", get: (r) => ({ text: r.phase }), priority: 2 },
];

describe("table", () => {
  test("ALLCAPS-ish headers (as given) + aligned columns", () => {
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

  test("truncates widest cell when over width, leaving room for both columns", () => {
    const rows: Row[] = [{ name: "a".repeat(40), phase: "adoption" }];
    const lines = table(rows, COLS, { color: false, unicode: true, width: 24 });
    // Each rendered line's visible width must fit in 24.
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(24);
    expect(lines[1]).toContain("…");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/presenter/primitives.test.ts`
Expected: FAIL — `table` not exported.

- [ ] **Step 3: Write minimal implementation (append)**

```ts
export type Cell = { readonly text: string; readonly tone?: Tone };
export type Column<R> = {
  readonly header: string;
  readonly get: (row: R) => Cell;
  readonly priority: number; // higher = dropped first under width pressure
  readonly align?: "left" | "right";
};

const INDENT = 2;
const COL_GAP = 2;

export function table<R>(
  rows: ReadonlyArray<R>,
  columns: ReadonlyArray<Column<R>>,
  caps: Caps,
): ReadonlyArray<string> {
  if (rows.length === 0) return [`  ${paint("(no rows)", "muted", caps)}`];

  // Resolve each cell's plain text once.
  const cellText = (col: Column<R>, row: R): string => col.get(row).text;

  // Natural width per column = max(header, cells).
  const widths = columns.map((col) =>
    Math.max(visibleWidth(col.header), ...rows.map((r) => visibleWidth(cellText(col, r)))),
  );

  // Width budget: indent + gaps + sum(widths) ≤ caps.width. If over, shrink the
  // widest column down (it will truncate). Never drop columns in v1 — callers
  // pick a small curated set, so shrinking is enough.
  const fixed = INDENT + COL_GAP * (columns.length - 1);
  let total = fixed + widths.reduce((a, b) => a + b, 0);
  while (total > caps.width) {
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest]! <= 4) break; // floor
    widths[widest]!--;
    total--;
  }

  const renderRow = (cells: ReadonlyArray<{ text: string; tone?: Tone }>): string => {
    const parts = cells.map((c, i) => {
      const w = widths[i]!;
      const clipped = truncate(c.text, w, caps.unicode);
      const padded = pad(clipped, w, columns[i]!.align ?? "left");
      return c.tone !== undefined ? paint(padded, c.tone, caps) : padded;
    });
    return " ".repeat(INDENT) + parts.join(" ".repeat(COL_GAP));
  };

  const header = renderRow(columns.map((c) => ({ text: c.header, tone: "muted" as Tone })));
  const body = rows.map((r) => renderRow(columns.map((c) => c.get(r))));
  return [header, ...body];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/cli/presenter/primitives.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/presenter/primitives.ts tests/cli/presenter/primitives.test.ts
git commit -m "feat(cli): add width-fit table primitive"
```

---

### Task 10: presenter barrel + typecheck gate

**Files:**
- Create: `src/cli/presenter/index.ts`

- [ ] **Step 1: Write the barrel**

```ts
// src/cli/presenter/index.ts
export * from "./caps";
export * from "./theme";
export * from "./humanize";
export * from "./width";
export * from "./primitives";
```

- [ ] **Step 2: Typecheck + full presenter test run**

Run: `bun run typecheck && bun test tests/cli/presenter`
Expected: PASS, no type errors.

- [ ] **Step 3: Commit**

```bash
git add src/cli/presenter/index.ts
git commit -m "feat(cli): add presenter barrel export"
```

**END OF PHASE 1.** The presenter exists and is fully tested. No command output has changed yet.

---

## PHASE 2 — Migrate the flagship surfaces (status, check, inspect) + delete the regex classifier

Phase 2 is where output changes and pinned assertions get re-baselined. Work command-by-command; after each, run that command against `docs/` and eyeball it before committing.

### Task 11: `status`/`check` status tone helper

The presenter needs `{tone, label}`, but `status`/`check` currently pass free strings classified by regex in `human-output.ts`. Add a small pure mapper so tone travels on the data.

**Files:**
- Create: `src/cli/commands/status-tone.ts`
- Test: `tests/cli/commands/status-tone.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { syncTone, freshnessTone } from "../../../src/cli/commands/status-tone";

describe("syncTone", () => {
  test("diverged → err, needed → warn, ok → ok", () => {
    expect(syncTone({ adopted_diverged: true, sync_needed: true })).toEqual({ tone: "err", label: "diverged" });
    expect(syncTone({ adopted_diverged: false, sync_needed: true })).toEqual({ tone: "warn", label: "needed" });
    expect(syncTone({ adopted_diverged: false, sync_needed: false })).toEqual({ tone: "ok", label: "ok" });
  });
});

describe("freshnessTone", () => {
  test("fresh → ok, stale → warn, cache drift annotated", () => {
    expect(freshnessTone({ projection_stale: false, projection_cache_drift: false })).toEqual({ tone: "ok", label: "fresh" });
    expect(freshnessTone({ projection_stale: true, projection_cache_drift: false })).toEqual({ tone: "warn", label: "stale" });
    expect(freshnessTone({ projection_stale: true, projection_cache_drift: true })).toEqual({ tone: "warn", label: "stale (cache drift)" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/commands/status-tone.test.ts` — FAIL (module missing).

- [ ] **Step 3: Implement `status-tone.ts`**

```ts
// src/cli/commands/status-tone.ts
import type { Status } from "../presenter";

export function syncTone(s: { adopted_diverged: boolean; sync_needed: boolean }): Status {
  if (s.adopted_diverged) return { tone: "err", label: "diverged" };
  if (s.sync_needed) return { tone: "warn", label: "needed" };
  return { tone: "ok", label: "ok" };
}

export function freshnessTone(s: { projection_stale: boolean; projection_cache_drift: boolean }): Status {
  if (!s.projection_stale) return { tone: "ok", label: "fresh" };
  return { tone: "warn", label: s.projection_cache_drift ? "stale (cache drift)" : "stale" };
}
```

- [ ] **Step 4: Run test** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(cli): add status tone mappers"`

### Task 12: render `status` through the presenter

**Files:**
- Modify: `src/cli/commands/status.ts` — replace `printStatusText` body; replace `formatHeadline/formatNextActionsBlock/formatSummaryRows/pushSection/formatBulletLines` imports with presenter `headline/section/kv/nextActions/bullets/footer/statusValue` + `resolveCaps`.

- [ ] **Step 1:** In `runStatus`, before `printStatusText`, add `const caps = resolveCaps();` and pass it: `printStatusText(snapshot, { showLoopDetails, caps })`.
- [ ] **Step 2:** Rewrite `printStatusText` to compose the spec's reference render:
  - `headline({ cmd: "status", context: basename(s.vault) }, { tone: s.attention_required ? "warn" : "ok", label: s.attention_required ? "needs attention" : "ok" }, caps)`
  - `section("Next", nextActions(s.next_actions, caps), caps)`
  - `section("At a glance", kv([...], caps), caps)` using `syncTone(s)`, `freshnessTone(s)`, draft/diagnostic/questions/serve rows with tones.
  - `section("Vault", kv([...], caps), caps)` — path uses `~`-shortened home (`s.vault.replace(os.homedir(), "~")`), head/adopted via `shortOid`, content summary line.
  - `section("Engine", kv([...], caps), caps)`.
  - When `showLoopDetails`: `section("Loops", tree(loopNodes, caps), caps)` (replaces `formatMaintenanceLoopDetailLines`; see Task 19).
  - Diagnostics section unchanged in content but rendered via `bullets`.
  - `footer({ tone, label }, caps)` summarizing attention.
  - `console.log(lines.join("\n"))`.
- [ ] **Step 3:** Run `bin/dome status --vault docs` and `bin/dome status --vault docs | cat` (TTY vs piped) and confirm color-on vs color-off + ASCII vs unicode degrade.
- [ ] **Step 4:** Re-baseline assertions in `tests/cli/commands.test.ts` and `tests/cli/human-output.test.ts` for status. Run `bun test tests/cli` and update expected strings to the new render (these are deliberate output changes; update them to match actual, then re-read to confirm they assert the intended shape).
- [ ] **Step 5:** Run `bun test tests/harness/scenarios/cli-surface` — update any status-touching scenario snapshots.
- [ ] **Step 6:** Commit — `git commit -m "feat(cli): render dome status through presenter"`

### Task 13: render `check` through the presenter

**Files:** Modify `src/cli/commands/check.ts` analogously (read it first; it shares the At-a-glance/Next/loops shape). Reuse `syncTone`/`freshnessTone`. Re-baseline `check` assertions in `tests/cli/commands.test.ts`. Commit `feat(cli): render dome check through presenter`.

### Task 14: `inspect` — per-subject curated `Column` specs + width-fit table

**Files:**
- Modify: `src/cli/commands/inspect.ts` — read it fully first; it currently calls `formatTable(rows)` from `format.ts` for every subject.
- Create: `src/cli/commands/inspect-columns.ts` — one `Column<Row>[]` per subject.
- Modify/Delete: remove `formatTable` from `src/cli/format.ts` once no caller remains (keep `formatJson`).

Curated columns per subject (human surface; `--json` keeps all fields):
- **processors:** `PROCESSOR` (id), `BUNDLE`, `PHASE`, `TRIGGERS`, `MODEL` (`statusGlyph` ok/pending). Drop `capabilities`, `bundle_grants`, `grant_scopes`, `grant_details`, `execution`.
- **runs:** `PROCESSOR`, `PHASE`, `STATUS` (toned: succeeded→ok, failed/timed_out/cancelled→err, running/queued→muted), `WHEN` (`relativeTime`), `TOOK` (`durationMs`). Drop full `id`, raw `started_at`, `proposal`.
- **bundles:** `BUNDLE`, `STATUS`, `MODEL`, `PROCESSORS` (count). 
- **patches / facts / diagnostics / questions / outbox / quarantine:** pick 4–5 human columns each (read the row shapes in `inspect.ts`; e.g. diagnostics → `SEVERITY` toned, `CODE`, `MESSAGE` truncated, `SOURCE`).

- [ ] **Step 1:** Write `tests/cli/commands/inspect-columns.test.ts` asserting the processors column set maps a sample row to `{name, bundle, phase, triggers, model-glyph}` and excludes grant blobs.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement `inspect-columns.ts` with `Column<R>[]` per subject + a `columnsFor(subject)` lookup.
- [ ] **Step 4:** In `inspect.ts`, replace `formatTable(rows)` with `table(rows, columnsFor(subject), caps)` plus a dim hidden-fields footer line (`bullets`/plain) naming what's hidden and `→ --json, or --<filter>`.
- [ ] **Step 5:** Run `bin/dome inspect processors --vault docs` and `bin/dome inspect runs --vault docs` — confirm rows fit an 80-col terminal.
- [ ] **Step 6:** Re-baseline inspect assertions in `tests/cli/commands.test.ts` (the smoke test) and any `cli-surface` scenario. Run `bun test tests/cli tests/harness/scenarios/cli-surface`.
- [ ] **Step 7:** Commit — `feat(cli): render dome inspect with curated width-fit columns`.

### Task 15: delete the regex status classifier

**Files:** Modify `src/cli/human-output.ts` — delete `colorizeHumanOutput`, `colorizeHumanLine`, `isGoodStatus`, `isBadStatus`, `isWarningStatus`, `formatHeadline`, `formatSummaryRows`, `formatSectionTitle`, `formatStatusValue`, `pushSection`, `formatNextActionsBlock`, `formatBulletLines` once status/check/inspect no longer import them. Keep only helpers still referenced elsewhere (grep first).

- [ ] **Step 1:** `grep -rn "human-output" src/cli` — confirm every remaining importer is migrated or will be in Phase 3.
- [ ] **Step 2:** Delete dead exports; run `bun run typecheck` — fix any remaining importer by migrating it now or stubbing via presenter.
- [ ] **Step 3:** Run `bun test tests/cli/human-output.test.ts` — delete/replace tests for deleted functions.
- [ ] **Step 4:** Commit — `refactor(cli): remove regex status classifier; tone travels on data`.

---

## PHASE 3 — Migrate remaining commands + final gates

Each command below is its own task: read the command file, replace its human-text block with presenter calls, re-baseline its tests, run it against `docs/` (or a temp vault for `init`/`sync`), commit. They all follow the Task 12 pattern using the Phase 1 primitives — no new primitives needed.

- [ ] **Task 16 — `sync` + `serve`** (`src/cli/commands/sync.ts`, `serve.ts`, `sync-shared.ts`): headline `{cmd:"sync", context}`, `COMPILED` + `OPERATIONAL` sections via `kv`, `footer`. Keep `--verbose` progress lines but route them to **stderr** (currently `console.log`); leave the final result block on stdout. Live spinner is **deferred** (spec §Deferred) — do not add `ora`. Re-baseline `tests/cli/sync.test.ts`, `tests/cli/serve.test.ts`.
- [ ] **Task 17 — `lint` + `doctor`**: headline + glyph status; findings via `table` (lint issues: `SEVERITY` toned, `CODE`, `MESSAGE`, `SOURCE`) or `bullets` (doctor findings); `footer`. Re-baseline `tests/harness/scenarios/cli-surface/lint-report.scenario.test.ts`, `doctor-health.scenario.test.ts`.
- [ ] **Task 18 — `query`**: headline `{cmd:"query"}`, a `MATCHES` section; each match = a titled line + dim provenance (`path`, `why`, `source`) — keep current information, restyle with `paint(...,"muted")` and `glyph("pointer")`. Re-baseline `query-adopted-state.scenario.test.ts`.
- [ ] **Task 19 — `init` + loop detail tree**: restyle `init`'s created/updated/skipped/already-present blocks via `section`+`bullets`; map the maintenance-loop detail (`formatMaintenanceLoopDetailLines` in `maintenance-loop-summary.ts`) onto `tree` nodes — one node per loop (`[state] id: goal`), child lines for processors/attention/settlement, suppressing repeated zero-count labels. Re-baseline `tests/cli/maintenance-loop-summary.test.ts`, `init` assertions, `init-claude-boot.scenario.test.ts`.
- [ ] **Task 20 — `resolve`/`answer`/`rebuild`/`run`**: small commands; restyle their result lines via `headline`+`statusValue`+`kv`. `run` renders an extension's view payload — keep its structured-view path; only restyle the wrapper headline. `export-context` is **untouched** (markdown is the product). Re-baseline any touched scenarios.

### Task 21: final gates + visual sweep

- [ ] **Step 1:** `bun run typecheck` — PASS.
- [ ] **Step 2:** `bun test` — full suite PASS (all re-baselined assertions green; invariant lockstep untouched).
- [ ] **Step 3:** Visual sweep — for each command run both TTY and piped:
  `for c in "status" "check" "lint" "doctor" "query adoption" "inspect processors" "inspect runs"; do echo "== $c =="; bin/dome $c --vault docs; bin/dome $c --vault docs | cat; done`
  Confirm: glyphs render on TTY, degrade to ASCII when `LANG=C`, no color when piped, no row exceeds terminal width, no markdown (`#`, backticks) in any human line.
- [ ] **Step 4:** `git diff --check` (no whitespace errors) and `bun run v1:smoke`.
- [ ] **Step 5:** Final commit — `refactor(cli): complete presenter migration across all commands`.

---

## Verification checklist (run before declaring done)

- [ ] `bun test` fully green; `bun run typecheck` clean.
- [ ] `bin/dome <cmd> --json` output byte-identical to pre-change for every command (the machine contract is frozen — diff a captured `--json` sample from before).
- [ ] `NO_COLOR=1 bin/dome status --vault docs` emits zero ANSI escapes.
- [ ] `bin/dome inspect processors --vault docs` fits in an 80-column terminal.
- [ ] No `src/cli` file outside `presenter/` reads `process.stdout.isTTY` / `NO_COLOR` directly (grep) — all go through `resolveCaps`.
- [ ] `src/index.ts` import graph does not reach `string-width` (`bun test tests/integration/bundle-deps.test.ts`).
