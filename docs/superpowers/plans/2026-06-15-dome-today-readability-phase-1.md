# `dome today` Readability — Phase 1 (Render) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `dome today` readable — surface source links as short clickable affordances (never sliced), stop mid-word truncation, and group tasks by urgency — all in the CLI presenter, with no meaning-loop change.

**Architecture:** Three presenter additions (`Caps.hyperlinks` + detection; `hyperlink`/`splitInlineLinks` in a new `links.ts`; `shortenLabel` in `width.ts`), then a rewrite of the task-list section of `formatTodayResult` to pull inline `[label](url)` links out of each task into trailing clickable `label↗` affordances, shorten the clean sentence at word/clause boundaries, and render `OVERDUE/TODAY/OPEN` sections with honest overflow counts.

**Tech Stack:** TypeScript on Bun; `bun test`; the CLI presenter layer (`src/cli/presenter/`) whose primitives are pure functions of an injected `Caps`; OSC 8 terminal hyperlinks.

**Design:** `docs/cohesive/brainstorms/2026-06-15-dome-today-readability.md` (approved 2026-06-15).

**Key facts (verified):**
- `Caps = { color, unicode, width }` (`src/cli/presenter/caps.ts`); built only by `resolveCaps(stream, env)`; primitives never read `process.env` directly; tests inject `Caps`.
- The today-view parser runs `stripWikilinks` on task text but NOT markdown links, so `[label](url)` survives into `view.openTasks[].text` (`src/surface/today-view.ts`).
- The task list is rendered in `formatTodayResult` (`src/cli/commands/today.ts`) — currently a flat list using `truncate(t.text, taskWidth)` (a blind char chop, `src/cli/presenter/width.ts:20`).
- Raw today-view document fields are camelCase: `date`, `openTasks`/`followups` (rows `{text, path, line, dueDate}`), `questions`, `counts.{openTasks,followups,questions}`, `hero`, `brief`, `calendar`.
- Presenter barrel: `src/cli/presenter/index.ts` re-exports `./caps ./theme ./humanize ./width ./primitives`.

---

### Task 1: `Caps.hyperlinks` capability + detection

**Files:**
- Modify: `src/cli/presenter/caps.ts`
- Test: `tests/cli/presenter/caps.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/cli/presenter/caps.test.ts`:

```ts
describe("resolveCaps hyperlinks", () => {
  const tty = { isTTY: true, columns: 100 };
  test("on for an allowlisted TERM_PROGRAM (iTerm)", () => {
    expect(resolveCaps(tty, { TERM_PROGRAM: "iTerm.app", LANG: "en_US.UTF-8" }).hyperlinks).toBe(true);
  });
  test("on for kitty via TERM", () => {
    expect(resolveCaps(tty, { TERM: "xterm-kitty" }).hyperlinks).toBe(true);
  });
  test("off for an unknown terminal", () => {
    expect(resolveCaps(tty, { TERM_PROGRAM: "Apple_Terminal" }).hyperlinks).toBe(false);
  });
  test("off when not a TTY (piped) even on iTerm", () => {
    expect(resolveCaps({ isTTY: false, columns: 100 }, { TERM_PROGRAM: "iTerm.app" }).hyperlinks).toBe(false);
  });
  test("forced on via DOME_HYPERLINKS even when piped", () => {
    expect(resolveCaps({ isTTY: false }, { DOME_HYPERLINKS: "1" }).hyperlinks).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/presenter/caps.test.ts -t hyperlinks`
Expected: FAIL — `hyperlinks` is `undefined` on the resolved Caps.

- [ ] **Step 3: Implement**

In `src/cli/presenter/caps.ts`, add `hyperlinks` to the type (optional, so existing `Caps` literals elsewhere still compile):

```ts
export type Caps = {
  readonly color: boolean;
  readonly unicode: boolean;
  readonly width: number;
  /** Terminal supports OSC 8 hyperlinks. Independent of `color`, like `unicode`. */
  readonly hyperlinks?: boolean;
};
```

Add the detector and wire it into `resolveCaps`:

```ts
function supportsHyperlinks(
  stream: OutStream,
  env: Record<string, string | undefined>,
): boolean {
  const force = env.DOME_HYPERLINKS ?? env.FORCE_HYPERLINK;
  if (force !== undefined) {
    return force.length > 0 && force !== "0" && force.toLowerCase() !== "false";
  }
  if (stream.isTTY !== true) return false;
  const prog = env.TERM_PROGRAM ?? "";
  if (prog === "iTerm.app" || prog === "WezTerm" || prog === "ghostty" || prog === "vscode") {
    return true;
  }
  if (/kitty/i.test(env.TERM ?? "")) return true;
  if (env.WT_SESSION !== undefined) return true; // Windows Terminal
  return false;
}
```

In `resolveCaps`, add to the returned object: `hyperlinks: supportsHyperlinks(stream, env),`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/cli/presenter/caps.test.ts`
Expected: PASS — all hyperlinks cases plus existing caps tests.

- [ ] **Step 5: Commit**

```bash
git add src/cli/presenter/caps.ts tests/cli/presenter/caps.test.ts
git commit -m "feat(cli): Caps.hyperlinks — detect OSC 8 terminal support"
```

---

### Task 2: `splitInlineLinks` — pull markdown links out of text

**Files:**
- Create: `src/cli/presenter/links.ts`
- Modify: `src/cli/presenter/index.ts` (add `export * from "./links";`)
- Test: `tests/cli/presenter/links.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/cli/presenter/links.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { splitInlineLinks } from "../../../src/cli/presenter/links";

describe("splitInlineLinks", () => {
  test("pulls one trailing link out and drops the dangling bullet separator", () => {
    const r = splitInlineLinks("Reply to Charlie re: Shankman · [thread](https://x/y)");
    expect(r.text).toBe("Reply to Charlie re: Shankman");
    expect(r.links).toEqual([{ label: "thread", url: "https://x/y" }]);
  });
  test("pulls multiple links in order", () => {
    const r = splitInlineLinks("Recruiting round w/ Guillaume [thread](https://a) [doc](https://b)");
    expect(r.text).toBe("Recruiting round w/ Guillaume");
    expect(r.links).toEqual([
      { label: "thread", url: "https://a" },
      { label: "doc", url: "https://b" },
    ]);
  });
  test("leaves link-free text untouched", () => {
    const r = splitInlineLinks("call the landlord");
    expect(r.text).toBe("call the landlord");
    expect(r.links).toEqual([]);
  });
  test("ignores image syntax", () => {
    const r = splitInlineLinks("see ![chart](https://img)");
    expect(r.text).toBe("see ![chart](https://img)");
    expect(r.links).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/presenter/links.test.ts`
Expected: FAIL — module `links.ts` does not exist.

- [ ] **Step 3: Implement**

Create `src/cli/presenter/links.ts`:

```ts
// src/cli/presenter/links.ts
// Inline-link handling for human CLI output: extract markdown links from a
// label so the URL never consumes visible width or gets truncated, and render
// them as OSC 8 terminal hyperlinks when the terminal supports it.

export type InlineLink = { readonly label: string; readonly url: string };

// [label](url) — label has no newline/bracket; url has no whitespace or ')'.
// A leading '!' (image) is captured so we can skip it.
const MD_LINK_RE = /(!?)\[([^\]\n]+)\]\(([^)\s]+)\)/g;

/**
 * Split inline markdown links out of a display label. Returns the cleaned text
 * (links removed, dangling bullet/pipe separators and double spaces collapsed)
 * and the links in source order. Image links (`![…]`) are left in place.
 */
export function splitInlineLinks(text: string): {
  readonly text: string;
  readonly links: ReadonlyArray<InlineLink>;
} {
  const links: InlineLink[] = [];
  const stripped = text.replace(MD_LINK_RE, (match, bang: string, label: string, url: string) => {
    if (bang === "!") return match; // image — leave untouched
    links.push({ label, url });
    return "";
  });
  if (links.length === 0) return { text, links };
  const cleaned = stripped
    .replace(/\s{2,}/g, " ")              // collapse runs left by removal
    .replace(/\s*[·|]\s*$/g, "")          // trailing bullet/pipe separator
    .replace(/^\s*[·|]\s*/g, "")          // leading bullet/pipe separator
    .trim();
  return { text: cleaned, links };
}
```

In `src/cli/presenter/index.ts`, add after the existing exports:

```ts
export * from "./links";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/cli/presenter/links.test.ts`
Expected: PASS — all four cases.

- [ ] **Step 5: Commit**

```bash
git add src/cli/presenter/links.ts src/cli/presenter/index.ts tests/cli/presenter/links.test.ts
git commit -m "feat(cli): splitInlineLinks — extract markdown links from labels"
```

---

### Task 3: `hyperlink` — OSC 8 affordance

**Files:**
- Modify: `src/cli/presenter/links.ts`
- Test: `tests/cli/presenter/links.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/cli/presenter/links.test.ts`:

```ts
import { hyperlink } from "../../../src/cli/presenter/links";
import type { Caps } from "../../../src/cli/presenter/caps";

const caps = (over: Partial<Caps> = {}): Caps => ({ color: true, unicode: true, width: 100, ...over });

describe("hyperlink", () => {
  test("emits an OSC 8 escape when hyperlinks are supported", () => {
    expect(hyperlink("thread", "https://x/y", caps({ hyperlinks: true }))).toBe(
      "\x1b]8;;https://x/y\x1b\\thread\x1b]8;;\x1b\\",
    );
  });
  test("returns the bare label when hyperlinks are off", () => {
    expect(hyperlink("thread", "https://x/y", caps({ hyperlinks: false }))).toBe("thread");
  });
  test("returns the bare label when url is empty", () => {
    expect(hyperlink("thread", "", caps({ hyperlinks: true }))).toBe("thread");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/presenter/links.test.ts -t hyperlink`
Expected: FAIL — `hyperlink` is not exported.

- [ ] **Step 3: Implement**

Add to `src/cli/presenter/links.ts`:

```ts
import type { Caps } from "./caps";

const OSC8 = "\x1b]8;;";
const ST = "\x1b\\";

/**
 * Render `label` as an OSC 8 terminal hyperlink to `url` when the terminal
 * supports it (`caps.hyperlinks`), else return the bare `label`. The escape
 * sequence carries zero visible columns, so width math must use the label
 * width, not this string's length.
 */
export function hyperlink(label: string, url: string, caps: Caps): string {
  if (caps.hyperlinks !== true || url.length === 0) return label;
  return `${OSC8}${url}${ST}${label}${OSC8}${ST}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/cli/presenter/links.test.ts`
Expected: PASS — splitInlineLinks + hyperlink cases all green.

- [ ] **Step 5: Commit**

```bash
git add src/cli/presenter/links.ts tests/cli/presenter/links.test.ts
git commit -m "feat(cli): hyperlink — OSC 8 terminal hyperlink primitive"
```

---

### Task 4: `shortenLabel` — word/clause-aware shortening

**Files:**
- Modify: `src/cli/presenter/width.ts`
- Test: `tests/cli/presenter/width.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/cli/presenter/width.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { shortenLabel } from "../../../src/cli/presenter/width";

describe("shortenLabel", () => {
  test("returns the text unchanged when it already fits", () => {
    expect(shortenLabel("short task", 40)).toBe("short task");
  });
  test("never cuts mid-word — backs off to the last word boundary", () => {
    const out = shortenLabel("confirm RH Chain launch-day token catalog work", 24);
    expect(out.endsWith("…")).toBe(true);
    // the visible portion before the ellipsis is whole words only
    const head = out.slice(0, -1).trimEnd();
    expect("confirm RH Chain launch-day token catalog work".startsWith(head)).toBe(true);
    expect(/\s\S+$/.test(head) || !head.includes(" ")).toBe(true); // last token is whole
    expect(head.endsWith("launch-day") || head.endsWith("Chain") || head.endsWith("token")).toBe(true);
  });
  test("prefers a clause boundary when one sits late in the fit", () => {
    // ':' is well past 60% of the fit → cut there
    const out = shortenLabel("Partner call: confirm the token catalog and the rest", 22);
    expect(out).toBe("Partner call:…");
  });
  test("ascii ellipsis when unicode is false", () => {
    expect(shortenLabel("one two three four five", 12, false).endsWith("...")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/presenter/width.test.ts`
Expected: FAIL — `shortenLabel` is not exported.

- [ ] **Step 3: Implement**

Add to `src/cli/presenter/width.ts` (after `truncate`):

```ts
/**
 * Shorten a one-line label to a visible width WITHOUT cutting mid-word.
 * Builds up to the budget, backs off to the last word boundary, and — when a
 * clause boundary (`:` or `—`) sits in the last ~40% of that head — cuts at the
 * clause instead. Appends the ellipsis. Returns the input unchanged when it
 * already fits. Call before paint(); operates on plain (uncolored) text.
 */
export function shortenLabel(text: string, width: number, unicode = true): string {
  if (visibleWidth(text) <= width) return text;
  const ell = unicode ? "…" : "...";
  const budget = Math.max(0, width - ell.length);
  let fit = "";
  for (const ch of text) {
    if (visibleWidth(fit + ch) > budget) break;
    fit += ch;
  }
  const lastSpace = fit.lastIndexOf(" ");
  let head = lastSpace > 0 ? fit.slice(0, lastSpace) : fit;
  const clauseIdx = Math.max(head.lastIndexOf(":"), head.lastIndexOf("—"));
  if (clauseIdx >= Math.floor(head.length * 0.6)) head = head.slice(0, clauseIdx + 1);
  return `${head.trimEnd()}${ell}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/cli/presenter/width.test.ts`
Expected: PASS — all four cases.

- [ ] **Step 5: Commit**

```bash
git add src/cli/presenter/width.ts tests/cli/presenter/width.test.ts
git commit -m "feat(cli): shortenLabel — word/clause-aware label shortening"
```

---

### Task 5: Group + link + shorten in `formatTodayResult`

**Files:**
- Modify: `src/cli/commands/today.ts` (imports + the `if (!isAllClear) { … }` block, ~lines 375-422)
- Test: `tests/cli/commands/today.test.ts`

- [ ] **Step 1: Write the failing test**

`formatTodayResult(data, caps, vault, opts)` is exported and takes a raw today-view document. Add direct unit tests to `tests/cli/commands/today.test.ts` (it already imports `formatTodayResult` and `resolveCaps`). Use a fixed-width, hyperlink-capable caps and a synthetic doc:

```ts
describe("formatTodayResult grouping + links", () => {
  const caps = { color: false, unicode: true, width: 80, hyperlinks: false } as const;
  const doc = (over: Record<string, unknown> = {}) => ({
    date: "2026-06-15",
    openTasks: [
      { text: "Reply to Charlie re: Shankman bar-raiser · [thread](https://uniswapteam.slack.com/archives/C0B81NJU/p123)", path: "wiki/dailies/2026-06-15.md", line: 4, dueDate: "2026-06-13" },
      { text: "polish the AI recruiting round with Guillaume so the panel is consistent across domains", path: "p", line: 5, dueDate: "2026-06-15" },
      { text: "draft the Q3 plan", path: "p", line: 6, dueDate: null },
    ],
    followups: [],
    questions: [],
    counts: { openTasks: 3, followups: 0, questions: 0 },
    hero: null, brief: null, calendar: null,
    ...over,
  });

  test("renders OVERDUE/TODAY/OPEN headers only for non-empty buckets", () => {
    const out = formatTodayResult(doc(), caps, "/v/work");
    expect(out).toContain("OVERDUE");
    expect(out).toContain("TODAY");
    expect(out).toContain("OPEN");
  });

  test("pulls the slack URL out of the line — no raw archives/ URL, link label survives", () => {
    const out = formatTodayResult(doc(), caps, "/v/work");
    expect(out).not.toContain("archives/C0B81NJU");
    expect(out).not.toContain("https://uniswapteam.slack.com");
    expect(out).toContain("thread"); // affordance label (plain, since hyperlinks:false)
    expect(out).toContain("Reply to Charlie re: Shankman bar-raiser");
  });

  test("no task line is cut mid-word (no severed token before the ellipsis)", () => {
    const narrow = { ...caps, width: 44 };
    const out = formatTodayResult(doc(), narrow, "/v/work");
    // every ellipsised task line ends a whole word (allow the clause-cut ':' too)
    for (const line of out.split("\n").filter((l) => l.includes("…"))) {
      const head = line.replace(/\s*….*$/, "");
      expect(/[A-Za-z0-9):\-]$/.test(head.trimEnd())).toBe(true);
    }
  });

  test("honest overflow: many open tasks report a '… N more' line", () => {
    const out = formatTodayResult(doc({ counts: { openTasks: 50, followups: 0, questions: 0 } }), caps, "/v/work");
    expect(out).toMatch(/…\s.*more.*dome today --verbose/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/commands/today.test.ts -t "grouping + links"`
Expected: FAIL — current flat renderer keeps the raw URL (so `archives/C0B81NJU` is present) and emits no `OVERDUE`/`TODAY`/`OPEN` headers.

- [ ] **Step 3: Implement**

In `src/cli/commands/today.ts`, extend the presenter import (the existing block importing `finding, glyph, headline, paint, …, truncate`) to add `shortenLabel`, `hyperlink`, `splitInlineLinks`, and `visibleWidth`:

```ts
import {
  finding,
  glyph,
  headline,
  hyperlink,
  paint,
  resolveCaps,
  rollup,
  shortenLabel,
  splitInlineLinks,
  statusGlyph,
  truncate,
  visibleWidth,
  type Caps,
  type Tone,
} from "../presenter";
```

Replace the entire body of the `if (!isAllClear) { … }` block (the flat-list section, from the `// Flat, signal-led list:` comment through the `lines.push(rollup([], caps));` line) with the grouped renderer:

```ts
  if (!isAllClear) {
    const isHeroTask = (t: TodayTaskRow): boolean =>
      hero !== null && hero.kind === "task" &&
      hero.item.text === t.text && hero.item.path === t.path &&
      hero.item.line === t.line;

    const nonHero = allTasks.filter((t) => !isHeroTask(t));
    const overdue = nonHero.filter((t) => t.dueDate !== null && t.dueDate < date);
    const dueToday = nonHero.filter((t) => t.dueDate !== null && t.dueDate === date);
    const open = nonHero.filter((t) => t.dueDate === null || t.dueDate > date);

    const taskWidth = Math.max(24, caps.width - 4); // "  <glyph> " leader = 4 cols
    const arrow = caps.unicode ? "↗" : "->";

    // Render one task row: clean sentence (links pulled out, shortened) + a
    // trailing clickable affordance per link. The URL never enters the visible
    // width, so it can never be sliced.
    const renderRow = (t: TodayTaskRow, tone: Tone): void => {
      const { text, links } = splitInlineLinks(t.text);
      const linkReserve = links.reduce((a, l) => a + visibleWidth(l.label) + 3, 0);
      const label = shortenLabel(text, Math.max(16, taskWidth - linkReserve), caps.unicode);
      const g = paint(statusGlyph(tone, caps), tone, caps);
      const affordances = links
        .map((l) => paint(`${hyperlink(l.label, l.url, caps)}${arrow}`, "ident", caps))
        .join("  ");
      const tail = affordances.length > 0 ? `   ${affordances}` : "";
      lines.push(`  ${g} ${label}${tail}`);
    };

    const OVERDUE_CAP = 6, TODAY_CAP = 4, OPEN_CAP = 4;
    const capOf = (n: number): number => (opts.verbose === true ? Number.POSITIVE_INFINITY : n);

    const section = (header: string, items: ReadonlyArray<TodayTaskRow>, capN: number, tone: Tone): number => {
      if (items.length === 0) return 0;
      lines.push(`  ${paint(header, "muted", caps)}`);
      const shown = Math.min(capOf(capN), items.length);
      for (const t of items.slice(0, shown)) renderRow(t, tone);
      return shown;
    };

    const overdueShown = section("OVERDUE", overdue, OVERDUE_CAP, "err");
    const todayShown = section("TODAY", dueToday, TODAY_CAP, "warn");
    const openShown = section("OPEN", open, OPEN_CAP, "plain");

    // Honest overflow using the view's TRUE totals (counts.*), not the received
    // (possibly display-capped) arrays. Overdue is reported exactly (the verdict
    // header already relies on the received list carrying all overdue); every
    // other non-shown task folds into a single "more" so the math never lies.
    const heroIsTask = hero !== null && hero.kind === "task";
    const trueTotal = (counts.openTasks + followupsTotal) - (heroIsTask ? 1 : 0);
    const overdueMore = Math.max(0, overdue.length - overdueShown);
    const otherMore = Math.max(0, (trueTotal - overdue.length) - (todayShown + openShown));
    if (overdueMore > 0 || otherMore > 0) {
      const parts: string[] = [];
      if (overdueMore > 0) parts.push(`${overdueMore} more overdue`);
      if (otherMore > 0) parts.push(`${otherMore} more`);
      lines.push(`  ${paint(`… ${parts.join(" · ")} · dome today --verbose`, "muted", caps)}`);
    }

    // ? ask line — top question + +N if more (unchanged)
    if (questions.length > 0) {
      const top = questions[0]!;
      const extra = questions.length - 1;
      const extraNote = extra > 0 ? `   ${paint(`+${extra}`, "muted", caps)}` : "";
      const askWidth = Math.max(24, caps.width - 40);
      const questionLabel = truncate(top.question, askWidth);
      lines.push(
        `  ? ${paint("ask", "muted", caps)}   #${top.id} ${questionLabel}   ${paint(top.resolveCommand, "ident", caps)}${extraNote}`,
      );
    }

    lines.push("");
    lines.push(rollup([], caps));
  }
```

Note: this removes the old `bucketed`/`TASK_CAP`/`shownOpen`/`overflow` locals entirely; they are fully replaced above. Leave the hero block, calendar block, all-clear block, and brief block unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/cli/commands/today.test.ts`
Expected: PASS — the new grouping/link tests pass and the existing end-to-end `dome today` tests still pass (the seeded "review the cockpit plan" task now renders under an `OPEN` header — if an existing assertion checked for the exact old flat shape, update it to the grouped shape; the task text itself is unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/today.ts tests/cli/commands/today.test.ts
git commit -m "feat(cli): dome today groups by urgency, pulls links to clickable affordances, no mid-word cuts"
```

---

### Task 6: Full suite + branch finish

- [ ] **Step 1: Run the full suite**

Run: `bun test`
Expected: PASS — entire suite green. Pay attention to `tests/cli/commands/today.test.ts`, `tests/surface/today-view.test.ts`, `tests/http/today-html.test.ts` (the HTML cockpit shares the parser, NOT this renderer, so it must be unaffected), and `tests/harness/scenarios/cli-surface/today-task-view.scenario.test.ts` (update its expected text if it asserts the old flat shape; the surfaced tasks are unchanged, only their grouping/affordance rendering).

- [ ] **Step 2: Manual smoke (recommended)**

In a hyperlink-capable terminal (iTerm2/WezTerm/kitty/Ghostty), run `bin/dome today` against a vault with overdue tasks carrying `[thread](url)` links. Confirm: grouped sections, no sliced URLs, `thread↗` is clickable, no mid-word cuts. (`DOME_HYPERLINKS=1` forces the escape on for testing in any terminal.)

- [ ] **Step 3: Finish the branch**

Invoke `superpowers:finishing-a-development-branch`. Per the repo convention the merge into `main` is `--no-ff`; a live `dome serve` does NOT need a restart for this change (it's CLI render only, not a processor), but a running `dome today --watch` re-renders on its own.

---

## Phase 2 (deferred — NOT in this plan)

Content/daemon work: shorter task titles at the source, consolidation of related open loops, stale-overdue cleanup. Its own brainstorm → spec → plan cycle. See `docs/cohesive/brainstorms/2026-06-15-dome-today-readability.md` §"Phase 2".
