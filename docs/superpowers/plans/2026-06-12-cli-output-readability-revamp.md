# CLI Output Readability Revamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Dome CLI's human output diagnostic-first and signal-dense — Rust/Elm-style findings, telemetry-free matches, relative times, dimmed zeros — without changing any `--json` output.

**Architecture:** Add four pure primitives/helpers to the existing `src/cli/presenter/` layer (`finding`, `match`, `dimZeros`, `humanizeCommand`/`stripTrailers`, plus a `wrap` width helper), then rewire each command renderer in `src/cli/commands/*` and `src/cli/maintenance-loop-summary.ts` to call them. The surface collectors (`src/surface/*`) and every `--json` path are untouched. One task touches a search processor (`assets/extensions/dome.search/processors/packet-render.ts`) — the only change outside `src/cli`.

**Tech Stack:** TypeScript on Bun; `bun:test`; `picocolors` for color; `string-width` for visible-width math. Presenter primitives are pure functions of `(input, Caps)`; tests inject `Caps` (`{ color, unicode, width }`) and assert exact strings.

**Spec:** `docs/superpowers/specs/2026-06-12-cli-output-readability-design.md`
**Predecessor:** `docs/superpowers/specs/2026-06-03-cli-presenter-design.md`

**Run tests with:** `bun test <path>` (single file) or `bun test tests/cli` (CLI suite).

---

## File structure

**Create:** none — all additions land in existing presenter files.

**Modify (presenter layer):**
- `src/cli/presenter/theme.ts` — add `Severity` type + `severityTone()`.
- `src/cli/presenter/width.ts` — add `wrap()`.
- `src/cli/presenter/humanize.ts` — add `humanizeCommand()`, `stripTrailers()`.
- `src/cli/presenter/primitives.ts` — add `dimZeros()`, `finding()`, `match()` + their types.

**Modify (renderers):**
- `src/cli/commands/status.ts`, `check.ts`, `doctor.ts`, `query.ts`, `log.ts`, `lint.ts`, `inspect.ts`, `today.ts`.
- `src/cli/maintenance-loop-summary.ts`.
- `assets/extensions/dome.search/processors/packet-render.ts` (export-context; Task 13 only).

**Test files (modify/extend):**
- `tests/cli/presenter/primitives.test.ts`, `theme.test.ts`, `humanize.test.ts`.
- `tests/cli/commands/*` (follow existing per-command test patterns).

---

## Task 1: `severityTone` — map diagnostic severity to a tone

**Files:**
- Modify: `src/cli/presenter/theme.ts`
- Test: `tests/cli/presenter/theme.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/cli/presenter/theme.test.ts`:

```ts
import { severityTone } from "../../../src/cli/presenter/theme";

describe("severityTone", () => {
  test("block and error map to err, warning to warn, info to info", () => {
    expect(severityTone("block")).toBe("err");
    expect(severityTone("error")).toBe("err");
    expect(severityTone("warning")).toBe("warn");
    expect(severityTone("info")).toBe("info");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/presenter/theme.test.ts`
Expected: FAIL — `severityTone is not a function` / import error.

- [ ] **Step 3: Add the implementation**

Append to `src/cli/presenter/theme.ts`:

```ts
export type Severity = "block" | "error" | "warning" | "info";

export function severityTone(severity: Severity): Tone {
  switch (severity) {
    case "block":
    case "error":
      return "err";
    case "warning":
      return "warn";
    case "info":
      return "info";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/cli/presenter/theme.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/presenter/theme.ts tests/cli/presenter/theme.test.ts
git commit -m "feat(cli): severityTone maps diagnostic severity to presenter tone"
```

---

## Task 2: `wrap` — word-wrap plain text to a visible width

**Files:**
- Modify: `src/cli/presenter/width.ts`
- Test: `tests/cli/presenter/primitives.test.ts` (the width helpers are tested here today)

- [ ] **Step 1: Write the failing test**

Append to `tests/cli/presenter/primitives.test.ts` (it already imports from `width`):

```ts
import { wrap } from "../../../src/cli/presenter/width";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/presenter/primitives.test.ts`
Expected: FAIL — `wrap is not a function`.

- [ ] **Step 3: Add the implementation**

Append to `src/cli/presenter/width.ts`:

```ts
/**
 * Word-wrap plain (uncolored) text to a visible width. Words longer than
 * `width` get their own line rather than being split mid-word. Always
 * returns at least one line. Call before paint().
 */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current === "") {
      current = word;
    } else if (visibleWidth(`${current} ${word}`) <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  lines.push(current);
  return lines;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/cli/presenter/primitives.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/presenter/width.ts tests/cli/presenter/primitives.test.ts
git commit -m "feat(cli): wrap() word-wraps plain text to a visible width"
```

---

## Task 3: `humanizeCommand` + `stripTrailers` — pure humanize helpers

**Files:**
- Modify: `src/cli/presenter/humanize.ts`
- Test: `tests/cli/presenter/humanize.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/cli/presenter/humanize.test.ts`:

```ts
import { humanizeCommand, stripTrailers } from "../../../src/cli/presenter/humanize";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/presenter/humanize.test.ts`
Expected: FAIL — functions not defined.

- [ ] **Step 3: Add the implementation**

Append to `src/cli/presenter/humanize.ts`:

```ts
/** Strip a trailing ` --json` flag from a suggested command for the human surface. */
export function humanizeCommand(command: string): string {
  return command.replace(/\s+--json$/, "");
}

const TRAILER_RE = /^[A-Za-z][A-Za-z0-9-]*:\s.+$/;

/**
 * Remove a trailing block of git trailer lines (e.g. `Co-Authored-By: …`,
 * `Signed-off-by: …`) from a commit body. Walks from the end and drops
 * consecutive `Key: value` lines plus the blank lines they leave behind.
 * Leaves bodies without a trailer block unchanged.
 */
export function stripTrailers(body: string): string {
  const lines = body.split("\n");
  let end = lines.length;
  while (end > 0 && (lines[end - 1] === "" || TRAILER_RE.test(lines[end - 1]!))) {
    end -= 1;
  }
  // Only treat as a trailer block if we actually removed at least one trailer line.
  const removed = lines.slice(end);
  if (!removed.some((l) => TRAILER_RE.test(l))) return body;
  return lines.slice(0, end).join("\n").replace(/\n+$/, "");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/cli/presenter/humanize.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/presenter/humanize.ts tests/cli/presenter/humanize.test.ts
git commit -m "feat(cli): humanizeCommand + stripTrailers humanize helpers"
```

---

## Task 4: `dimZeros` — dim zero-valued terms in a count string

**Files:**
- Modify: `src/cli/presenter/primitives.ts`
- Test: `tests/cli/presenter/primitives.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/cli/presenter/primitives.test.ts`:

```ts
import { dimZeros } from "../../../src/cli/presenter/primitives";

const ASCII = { color: false, unicode: false, width: 80 };
const COLOR = { color: true, unicode: true, width: 80 };

describe("dimZeros", () => {
  test("joins terms with the separator and no color when color:false", () => {
    expect(dimZeros(["9 known", "0 attention", "2 partial"], ASCII)).toBe(
      "9 known · 0 attention · 2 partial",
    );
  });
  test("paints only the zero terms muted when color:true", () => {
    const out = dimZeros(["0 failed", "1 live"], COLOR);
    expect(out).toContain("1 live"); // non-zero term is not painted
    expect(out.indexOf("1 live")).toBe(out.lastIndexOf("1 live")); // appears once, unwrapped
    expect(out).toContain("\x1b["); // zero term carries an ANSI escape
    expect(out).toContain("0 failed");
  });
  test("treats a bare 0 and 0-prefixed counts as zero, but not 10", () => {
    expect(dimZeros(["10 known", "0"], ASCII)).toBe("10 known · 0");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/presenter/primitives.test.ts`
Expected: FAIL — `dimZeros is not a function`.

- [ ] **Step 3: Add the implementation**

In `src/cli/presenter/primitives.ts`, add near the other helpers (it already imports `paint`, `glyph`, `type Tone` from `./theme`):

```ts
/**
 * Join count terms with the `·` separator, painting any term whose count is
 * zero in the muted tone so the eye skips it. Terms are never removed or
 * reordered — layout stays stable. A term is "zero" when it starts with `0`
 * not followed by another digit (so `0`, `0 failed` dim; `10 known` does not).
 */
export function dimZeros(terms: ReadonlyArray<string>, caps: Caps): string {
  const sep = ` ${glyph("sep", caps)} `;
  return terms
    .map((t) => (/^0(?!\d)/.test(t) ? paint(t, "muted", caps) : t))
    .join(sep);
}
```

(`Caps` is already imported at the top of `primitives.ts` via `import type { Caps } from "./caps";`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/cli/presenter/primitives.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/presenter/primitives.ts tests/cli/presenter/primitives.test.ts
git commit -m "feat(cli): dimZeros dims zero count-terms while keeping layout stable"
```

---

## Task 5: `finding` primitive — Rust/Elm-style diagnostic anatomy

**Files:**
- Modify: `src/cli/presenter/primitives.ts`
- Test: `tests/cli/presenter/primitives.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/cli/presenter/primitives.test.ts`:

```ts
import { finding, type Finding } from "../../../src/cli/presenter/primitives";

const UNI = { color: false, unicode: true, width: 80 };

describe("finding", () => {
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/presenter/primitives.test.ts`
Expected: FAIL — `finding is not a function`.

- [ ] **Step 3: Add the implementation**

In `src/cli/presenter/primitives.ts`, add `statusGlyph`, `severityTone`, `type Severity` to the existing import from `./theme`, then add:

```ts
export type Finding = {
  readonly severity: Severity;
  readonly code: string;
  readonly subject?: string;
  readonly what: string;
  readonly note?: string;
  readonly fix?: string;
};

const FINDING_INDENT = "      "; // 6 spaces — content column
const FINDING_LABEL_WIDTH = 4; // "note", "fix " padded equal

function findingLabeledLines(label: string, text: string, caps: Caps): string[] {
  const labelCell = paint(pad(label, FINDING_LABEL_WIDTH), "muted", caps);
  // hanging indent: continuation lines align under the text, past label + 3 gap
  const textIndent = " ".repeat(FINDING_INDENT.length + FINDING_LABEL_WIDTH + 3);
  const avail = Math.max(8, caps.width - textIndent.length);
  const [first, ...rest] = wrap(text, avail);
  const out = [`${FINDING_INDENT}${labelCell}   ${first ?? ""}`];
  for (const line of rest) out.push(`${textIndent}${line}`);
  return out;
}

/**
 * Render one diagnostic finding in the Rust/Elm anatomy: a severity-glyph +
 * code (+ optional subject) header, a plain-language `what` line, then an
 * optional dim `note` (why it matters) and `fix` (suggestion), each on its
 * own line. The full original message lives in `--json`.
 */
export function finding(f: Finding, caps: Caps): ReadonlyArray<string> {
  const tone = severityTone(f.severity);
  const g = paint(statusGlyph(tone, caps), tone, caps);
  const code = paint(f.code, tone, caps);
  const header =
    f.subject !== undefined
      ? `  ${g} ${code} ${glyph("sep", caps)} ${paint(f.subject, "muted", caps)}`
      : `  ${g} ${code}`;
  const out: string[] = [header];
  // `what` wraps under the content column (no label).
  const whatAvail = Math.max(8, caps.width - FINDING_INDENT.length);
  for (const line of wrap(f.what, whatAvail)) out.push(`${FINDING_INDENT}${line}`);
  if (f.note !== undefined) out.push(...findingLabeledLines("note", f.note, caps));
  if (f.fix !== undefined) out.push(...findingLabeledLines("fix", f.fix, caps));
  return out;
}
```

Add `wrap` to the existing import from `./width` at the top of `primitives.ts` (`import { pad, truncate, visibleWidth, wrap } from "./width";`).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/cli/presenter/primitives.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/presenter/primitives.ts tests/cli/presenter/primitives.test.ts
git commit -m "feat(cli): finding primitive renders Rust/Elm-style diagnostic anatomy"
```

---

## Task 6: `match` primitive — telemetry-free search result

**Files:**
- Modify: `src/cli/presenter/primitives.ts`
- Test: `tests/cli/presenter/primitives.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/cli/presenter/primitives.test.ts`:

```ts
import { match, type MatchView } from "../../../src/cli/presenter/primitives";

describe("match", () => {
  test("rank+title left, path right-aligned, breadcrumb, snippet, source ref", () => {
    const wide = { color: false, unicode: true, width: 60 };
    const m: MatchView = {
      rank: 1,
      title: "Effect router targets",
      path: "wiki/matrices/effect-router-targets.md",
      breadcrumb: "Phase compatibility precedes capability enforcement",
      snippet: "the rejected effect is not applied",
      sourceRef: "ba1de2b · lines 46–56",
    };
    expect(match(m, wide)).toEqual([
      "  1  Effect router targets…  wiki/matrices/effect-router-targets.md",
      "     › Phase compatibility precedes capability enforcement",
      "     the rejected effect is not applied",
      "     ba1de2b · lines 46–56",
    ]);
  });

  test("omits breadcrumb/snippet/source lines when absent", () => {
    const wide = { color: false, unicode: true, width: 60 };
    const m: MatchView = { rank: 2, title: "SDK surface", path: "wiki/specs/sdk-surface.md" };
    expect(match(m, wide)).toEqual([
      "  2  SDK surface                          wiki/specs/sdk-surface.md",
    ]);
  });
});
```

> Note for the implementer: the first test's exact spacing depends on the right-align math at width 60. Run the test, read the actual rendered string from the failure diff, and lock the expectation to it — the *structure* (rank+title left, path right, then indented breadcrumb/snippet/ref) is the contract, not the hand-counted spaces.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/presenter/primitives.test.ts`
Expected: FAIL — `match is not a function`.

- [ ] **Step 3: Add the implementation**

In `src/cli/presenter/primitives.ts`, add:

```ts
export type MatchView = {
  readonly rank: number;
  readonly title: string;
  readonly path: string;
  readonly breadcrumb?: string;
  readonly snippet?: string;
  readonly sourceRef?: string;
};

const MATCH_INDENT = "     "; // 5 spaces — aligns under the title

/**
 * Render one search match: `rank  title` on the left with `path` right-aligned
 * to the terminal width, then optional indented breadcrumb (`›`), snippet, and
 * a compact source ref. Ranking telemetry and facts live in `--json`.
 */
export function match(m: MatchView, caps: Caps): ReadonlyArray<string> {
  const left = `  ${m.rank}  `;
  const gap = 2;
  const pathWidth = visibleWidth(m.path);
  const titleBudget = Math.max(4, caps.width - left.length - pathWidth - gap);
  const title = truncate(m.title, titleBudget, caps.unicode);
  const used = left.length + visibleWidth(title);
  const spacer = " ".repeat(Math.max(gap, caps.width - used - pathWidth));
  const out: string[] = [`${left}${title}${spacer}${paint(m.path, "muted", caps)}`];
  if (m.breadcrumb !== undefined) {
    out.push(`${MATCH_INDENT}${paint(`› ${m.breadcrumb}`, "muted", caps)}`);
  }
  if (m.snippet !== undefined) {
    for (const line of wrap(m.snippet, Math.max(8, caps.width - MATCH_INDENT.length))) {
      out.push(`${MATCH_INDENT}${line}`);
    }
  }
  if (m.sourceRef !== undefined) {
    out.push(`${MATCH_INDENT}${paint(m.sourceRef, "ident", caps)}`);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/cli/presenter/primitives.test.ts`
Expected: PASS (after locking the spacing per the Step 1 note).

- [ ] **Step 5: Commit**

```bash
git add src/cli/presenter/primitives.ts tests/cli/presenter/primitives.test.ts
git commit -m "feat(cli): match primitive renders telemetry-free search results"
```

---

## Task 7: Wire `status` — relative time, dimmed zeros, humanized next-action

**Files:**
- Modify: `src/cli/commands/status.ts`
- Test: `tests/cli/commands/status.test.ts` (follow existing patterns; if absent, add focused assertions)

- [ ] **Step 1: Write the failing test**

Add to the status command test (adapt to the existing harness — these build a `StatusSnapshot` fixture and call the text renderer). Assert the three behaviors:

```ts
test("last sync renders as relative time, not raw ISO", () => {
  // build snapshot with last_sync two hours before a fixed `now`, render, assert:
  expect(rendered).toContain("last sync    2h ago");
  expect(rendered).not.toContain("2026-06-12T22:00:16");
});

test("zero count-terms are present but the next-action drops --json", () => {
  expect(rendered).toContain("→ dome sync"); // not "dome sync --json"
  expect(rendered).not.toContain("dome sync --json");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/commands/status.test.ts`
Expected: FAIL — output still shows the ISO timestamp and `--json`.

- [ ] **Step 3: Implement the renderer changes**

In `src/cli/commands/status.ts`:

1. Import the new helpers:
```ts
import { relativeTime } from "../presenter"; // already re-exported via humanize
import { dimZeros } from "../presenter";
import { humanizeCommand } from "../presenter";
```

2. In `nextActions` rendering, the command string passed in must be humanized. The `nextActions` primitive renders `a.command`; the cleanest fix is at the data boundary in `printStatusText` — map the snapshot's next actions through `humanizeCommand` before passing to `nextActions`:
```ts
lines.push(
  ...section(
    "Next",
    nextActions(
      s.next_actions.map((a) => ({
        command: a.command === null ? null : humanizeCommand(a.command),
        description: a.description,
      })),
      caps,
    ),
    caps,
  ),
);
```

3. Change `last sync` to relative time (keep ISO in `--json`, which is unaffected):
```ts
{ label: "last sync", value: s.last_sync === null ? "(never)" : relativeTime(s.last_sync), tone: "muted" },
```

4. Dim zeros in the runs / outbox / loops rows. Replace the `runs` and `outbox` value strings:
```ts
{ label: "runs", value: dimZeros([formatPendingRuns(s), `${s.failed_runs} failed`], caps) },
{ label: "outbox", value: dimZeros([`${s.outbox_pending} pending`, `${s.outbox_failed} failed`], caps) },
```
(`formatPendingRuns` already yields e.g. `"0"` / `"3 live"`; dimZeros dims the bare `0`.)

5. The loops line is produced by `formatMaintenanceLoopSummaryLine` — that gets the dim-zero treatment in Task 12. Leave its call site here unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/cli/commands/status.test.ts`
Expected: PASS. Then run `bin/dome status --vault docs` and eyeball it.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/status.ts tests/cli/commands/status.test.ts
git commit -m "feat(cli): status uses relative time, dimmed zeros, humanized next-action"
```

---

## Task 8: Wire `check` — findings via the `finding` primitive

**Files:**
- Modify: `src/cli/commands/check.ts`
- Test: `tests/cli/commands/check.test.ts`

- [ ] **Step 1: Read the current renderer**

Read `src/cli/commands/check.ts` and locate where engine findings are printed (today: `[severity] code: message` + `recovery:` line). Identify the finding data shape (severity, code, subject/processor, message, recovery fields).

- [ ] **Step 2: Write the failing test**

```ts
test("engine findings render with severity glyph, code·subject header, and a fix line", () => {
  // fixture with one warning finding (code, processor subject, message, recovery)
  expect(rendered).toContain("⚠ capability.grant-entry-missing · dome.markdown.core-size");
  expect(rendered).toContain("      fix    ");
  // the run-on "[warning] …: … ; …" form is gone from human output
  expect(rendered).not.toContain("[warning]");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/cli/commands/check.test.ts`
Expected: FAIL — still prints `[warning] …`.

- [ ] **Step 4: Implement**

Replace the per-finding rendering block with a map to the `finding` primitive. Field mapping per spec: `message → what`, `recovery → fix`, processor id `→ subject`, `note` omitted (no distinct consequence field today):

```ts
import { finding, type Finding } from "../presenter";

const findingLines = engineFindings.flatMap((d) =>
  finding(
    {
      severity: d.severity as Finding["severity"],
      code: d.code,
      subject: d.processor ?? undefined,
      what: d.message,
      fix: d.recovery ?? undefined,
    },
    caps,
  ).concat(""), // blank line between findings
);
lines.push(...section("Engine findings", findingLines.slice(0, -1), caps));
```

Sort findings by severity (err → warn → info) before mapping, matching the spec's ordering rule.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/cli/commands/check.test.ts`
Expected: PASS. Eyeball `bin/dome check --vault docs`.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/check.ts tests/cli/commands/check.test.ts
git commit -m "feat(cli): check renders findings via the finding primitive"
```

---

## Task 9: Wire `doctor` — findings via primitive + dim-zero breakdown

**Files:**
- Modify: `src/cli/commands/doctor.ts`
- Test: `tests/cli/commands/doctor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("findings use the finding primitive and the breakdown dims zeros", () => {
  expect(rendered).toContain("⚠ capability.grant-entry-missing · dome.markdown.core-size");
  expect(rendered).not.toContain("[warning]");
  // breakdown line still lists every term (stable layout)
  expect(rendered).toContain("outbox 0 failed");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/commands/doctor.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Same `finding`-primitive mapping as Task 8 for the `FINDINGS` section. For the all-zeros `AT A GLANCE` breakdown line (`outbox 0 failed · 0 stuck · orphans 0 · …`), build the term list and pass it through `dimZeros(terms, caps)` instead of `.join(" · ")`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/cli/commands/doctor.test.ts`
Expected: PASS. Eyeball `bin/dome doctor --vault docs`.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/doctor.ts tests/cli/commands/doctor.test.ts
git commit -m "feat(cli): doctor uses finding primitive and dims breakdown zeros"
```

---

## Task 10: Wire `query` — `match` primitive, drop telemetry

**Files:**
- Modify: `src/cli/commands/query.ts`
- Test: `tests/cli/commands/query.test.ts` — **does not exist yet; create it**, following the fixture/assertion style of `tests/cli/commands/check.test.ts` and the shared `tests/cli/commands/fixture.ts`.

- [ ] **Step 1: Write the failing test**

```ts
test("matches render via the match primitive without ranking/facts telemetry", () => {
  // fixture with one match (title, path, breadcrumb, snippet, sourceRefs, ranking, facts)
  expect(rendered).toContain("1  Effect router targets");
  expect(rendered).not.toContain("why:");
  expect(rendered).not.toContain("fts");
  expect(rendered).not.toContain("facts:");
});

test("result summary reads 'showing N of M' when there is more", () => {
  expect(rendered).toContain("showing 10 of");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/commands/query.test.ts`
Expected: FAIL — `why:`/`facts:` still present.

- [ ] **Step 3: Implement**

In `formatQueryResult` (`src/cli/commands/query.ts`), replace the per-match block (lines that push `path:`, `section:`, `text:`, `why:`, `source:`, `facts:`) with a map to the `match` primitive:

```ts
import { match, type MatchView } from "../presenter";

const matchLines = result.matches.flatMap((m, i) =>
  match(
    {
      rank: i + 1,
      title: m.title,
      path: m.path,
      breadcrumb: m.breadcrumb !== null && m.breadcrumb !== m.title ? m.breadcrumb : undefined,
      snippet: m.snippet.length > 0 ? stripFtsMarkers(m.snippet) : undefined,
      sourceRef: m.sourceRefs.length > 0 ? formatSourceRef(m.sourceRefs[0]!) : undefined,
    } satisfies MatchView,
    caps,
  ).concat(""),
);
```

Replace the `QUERY` kv block (`text`/`shown`/`limit`/`has more`) with a single human summary line under the header:
```ts
const summary = result.hasMore.matches
  ? `"${result.query}" — showing ${n} of ${result.totalMatches ?? "more"}, raise with --limit`
  : `"${result.query}" — ${n} ${matchLabel}`;
lines.push("", `  ${paint(summary, "muted", caps)}`);
```
(If the snapshot has no `totalMatches`, keep the `shown/has more` data in `--json` and use the simpler `showing N, raise with --limit` phrasing — do not invent a total.)

Keep the existing `n === 0` empty-state branch but conform its header glyph to `○`/muted (already `{ tone: "muted", label: "no matches" }`).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/cli/commands/query.test.ts`
Expected: PASS. Eyeball `bin/dome query "capability broker" --vault docs`.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/query.ts tests/cli/commands/query.test.ts
git commit -m "feat(cli): query renders matches via the match primitive, telemetry to --json"
```

---

## Task 11: Wire `log` — relative time + trailer strip

**Files:**
- Modify: `src/cli/commands/log.ts`
- Test: `tests/cli/commands/log.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("entries show relative time and drop commit trailers from the body", () => {
  expect(rendered).toMatch(/\dh ago · /); // relative, not ISO
  expect(rendered).not.toContain("Co-Authored-By:");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/commands/log.test.ts`
Expected: FAIL — ISO timestamp + trailer present.

- [ ] **Step 3: Implement**

In `src/cli/commands/log.ts`: replace the timestamp formatting with `relativeTime(entry.timestamp)`, and run each entry's body through `stripTrailers(body)` before printing. Import both from `../presenter`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/cli/commands/log.test.ts`
Expected: PASS. Eyeball `bin/dome log --vault docs`.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/log.ts tests/cli/commands/log.test.ts
git commit -m "feat(cli): log shows relative time and strips commit trailers"
```

---

## Task 12: Wire `maintenance-loop-summary` + `lint` — dim zeros, finding anatomy

**Files:**
- Modify: `src/cli/maintenance-loop-summary.ts`, `src/cli/commands/lint.ts`
- Test: `tests/cli/maintenance-loop-summary.test.ts`, `tests/cli/commands/lint.test.ts`

- [ ] **Step 1: Write the failing tests**

For the loop summary line:
```ts
test("summary line keeps every term but a color cap dims the zeros", () => {
  const line = formatMaintenanceLoopSummaryLine(loops /* 1 quiet, 0 attention, 0 drift, 2 partial, 6 inactive */, COLOR_CAPS);
  expect(line).toContain("0 attention");
  expect(line).toContain("\x1b["); // a zero term is painted
});
```
For lint:
```ts
test("issues breakdown dims zeros; issues (when present) use the finding primitive", () => {
  expect(rendered).toContain("0 block"); // present, stable layout
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/cli/maintenance-loop-summary.test.ts tests/cli/commands/lint.test.ts`
Expected: FAIL — `formatMaintenanceLoopSummaryLine` takes no `caps` yet.

- [ ] **Step 3: Implement**

In `src/cli/maintenance-loop-summary.ts`, change `formatMaintenanceLoopSummaryLine(loops)` to accept `caps: Caps` and build the line via `dimZeros([...terms], caps)` instead of the manual ` · ` join. Update its one call site in `src/cli/commands/status.ts` (and any other) to pass `caps`.

In `src/cli/commands/lint.ts`, pass the issues breakdown terms through `dimZeros(terms, caps)`, and render any present issues through the `finding` primitive (map lint issue severity/code/message/fix). When there are zero issues the `ISSUES` section stays `none`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/cli/maintenance-loop-summary.test.ts tests/cli/commands/lint.test.ts tests/cli/commands/status.test.ts`
Expected: PASS. Eyeball `bin/dome status --vault docs` and `bin/dome lint --vault docs`.

- [ ] **Step 5: Commit**

```bash
git add src/cli/maintenance-loop-summary.ts src/cli/commands/lint.ts src/cli/commands/status.ts tests/cli/maintenance-loop-summary.test.ts tests/cli/commands/lint.test.ts
git commit -m "feat(cli): dim zeros in loop summary + lint, lint issues via finding primitive"
```

---

## Task 13: Conform verdict headers — `inspect`, `today`, empty/error states

**Files:**
- Modify: `src/cli/commands/inspect.ts`, `src/cli/commands/today.ts`
- Test: `tests/cli/commands/inspect.test.ts`, `tests/cli/commands/today.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// inspect: neutral count uses •, empty uses ○
test("inspect verdict header uses • for rows and ○ for none", () => {
  expect(renderedWithRows).toMatch(/• \d+ rows/);
  expect(renderedEmpty).toContain("○ no rows");
});

// today: uninstalled state gains a verdict header + finding-style fix line
test("today uninstalled renders a verdict header and a fix line", () => {
  expect(rendered).toContain("dome today");
  expect(rendered).toContain("✗ not available");
  expect(rendered).toContain("dome init --refresh-config");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/cli/commands/inspect.test.ts tests/cli/commands/today.test.ts`
Expected: FAIL — today prints a bare sentence; inspect uses `*`/`o` ad hoc.

- [ ] **Step 3: Implement**

`inspect.ts`: ensure the verdict tone is `info`/`•` for non-empty result counts and `muted`/`○` for empty (the glyphs already map correctly via `statusGlyph`; the fix is choosing the tone consistently). No table-body changes.

`today.ts`: when `dome.daily`/today processor is absent, render through `headline(... { tone: "err", label: "not available" })` + the `finding` primitive:
```ts
const lines = [
  headline({ cmd: "today", context: basename(vault) }, { tone: "err", label: "not available" }, caps),
  "",
  ...finding({
    severity: "error",
    code: "dome.daily not installed",
    what: "no today processor is enabled for this vault",
    fix: "dome init --refresh-config   (adds current first-party defaults)",
  }, caps),
];
console.log(lines.join("\n"));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/cli/commands/inspect.test.ts tests/cli/commands/today.test.ts`
Expected: PASS. Eyeball `bin/dome inspect runs --vault docs`, `bin/dome inspect questions --vault docs`, `bin/dome today --vault docs`.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/inspect.ts src/cli/commands/today.ts tests/cli/commands/inspect.test.ts tests/cli/commands/today.test.ts
git commit -m "feat(cli): conform verdict headers for inspect/today + error states"
```

---

## Task 14: `export-context` — qualitative relevance, trim facts (processor)

**Files:**
- Modify: `assets/extensions/dome.search/processors/packet-render.ts`
- Test: the existing test for this processor (find via `grep -rl packet-render tests`)

> This is the **only** task outside `src/cli`. The export-context packet is markdown built by a processor, and is itself an agent-facing deliverable — so it keeps its document structure; only the telemetry is humanized.

- [ ] **Step 1: Find or create the processor test**

Run: `grep -rl "packet-render\|export-context\|Read First" tests` to find an existing packet test. There is no dedicated packet-render unit test today, so most likely **create** `tests/extensions/search-packet-render.test.ts`, following the style of `tests/extensions/search-query-dedupe.test.ts` (which already exercises the search bundle). Build a small adopted-state fixture and render a packet.

- [ ] **Step 2: Write the failing test**

Assert the `Ranking: … (score …, fts …)` line is replaced by a qualitative `Relevance:` line and the `… N more facts` dump is trimmed:
```ts
test("packet uses qualitative relevance, not raw fts scores", () => {
  expect(packet).not.toContain("fts ");
  expect(packet).not.toMatch(/score \d/);
  expect(packet).toContain("Relevance:");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test <packet-render test path>`
Expected: FAIL.

- [ ] **Step 4: Implement**

In `packet-render.ts`, change the `Ranking:` line to emit only the qualitative reasons (drop `(score …, fts …)`), rename the label to `Relevance:`, and cap the facts list at a small N with a count (`… and N more (see --json)`) instead of dumping all facts. Keep the `## Read First` / per-match structure intact.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test <packet-render test path>`
Expected: PASS. Eyeball `bin/dome export-context "adoption loop" --vault docs`.

- [ ] **Step 6: Commit**

```bash
git add assets/extensions/dome.search/processors/packet-render.ts tests/<path>
git commit -m "feat(search): export-context packet uses qualitative relevance, trims fact dump"
```

---

## Task 15: Full-suite verification + docs

**Files:**
- Modify: `docs/wiki/specs/cli.md` (if it documents output shapes), `tests/cli/**`

- [ ] **Step 1: Run the full CLI test suite**

Run: `bun test tests/cli`
Expected: PASS (all command + presenter tests green).

- [ ] **Step 2: Run the whole suite (catch invariant/integration fallout)**

Run: `bun test`
Expected: PASS. If `tests/cli/bin.test.ts` or any golden test asserts old output shapes, update those assertions to the new rendering (the `--json` assertions must remain byte-identical — if any `--json` test changed, that is a bug to fix, not an assertion to update).

- [ ] **Step 3: Walk every command by hand against the docs vault**

Run each and confirm the new design holds together:
```bash
bin/dome status --vault docs
bin/dome check --vault docs
bin/dome doctor --vault docs
bin/dome query "capability broker" --vault docs
bin/dome export-context "adoption loop" --vault docs
bin/dome log --vault docs
bin/dome lint --vault docs
bin/dome inspect runs --vault docs
bin/dome inspect processors --vault docs
bin/dome inspect questions --vault docs
bin/dome inspect cost --vault docs
bin/dome today --vault docs
```
Confirm: consistent verdict headers, findings in the new anatomy, no `why:`/`fts` telemetry, relative times, dimmed zeros, no commit trailers in `log`.

- [ ] **Step 4: Update CLI spec doc if needed**

If `docs/wiki/specs/cli.md` documents output shapes that changed, update the relevant sections to match. Note the `note`-line follow-up (consequence enrichment of diagnostics) as out-of-scope future work.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test(cli): full-suite green for output readability revamp; doc sync"
```

---

## Follow-up (out of scope — do NOT implement here)

**Diagnostic consequence enrichment.** The `finding` primitive supports a dim `note` line for *why a finding matters*, but no diagnostic carries a distinct consequence field today (the consequence is fused into `message`). A separate effort should add an optional `consequence` to the diagnostics that processors emit, after which `what` becomes the terse claim and `note` the consequence — no further rendering change needed. Track as its own spec/plan.

---

## Self-review notes

- **Spec coverage:** glyph contract (Tasks 1, 13) · verdict header grammar (7, 13) · Next line / humanizeCommand (3, 7) · Finding primitive (5, 8, 9, 12, 13) · Match primitive (6, 10) · relative time + trailer strip (3, 7, 11) · dim-zero rule (4, 7, 9, 12) · export-context special case (14) · testing across Caps + `--json` byte-identity (all tasks + 15). All spec sections map to a task.
- **`--json` safety:** no task edits a surface collector or a `formatJson` call; Task 15 Step 2 explicitly guards `--json` byte-identity.
- **Type consistency:** `Finding`/`MatchView`/`Severity` defined in Tasks 1/5/6 are reused by name in Tasks 8–14; `dimZeros`, `wrap`, `humanizeCommand`, `stripTrailers`, `relativeTime` signatures are fixed at definition and called unchanged downstream.
- **Note-line honesty:** the `note` field is rendered-but-usually-absent in this revamp (no data source yet); enrichment is the flagged follow-up.
