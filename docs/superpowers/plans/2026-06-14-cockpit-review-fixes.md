# Cockpit Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the nine cockpit review findings — correctness (count honesty, poll-flash), fidelity (web urgency grouping, terminal all-clear, hero day-count), and maintainability (consolidate `stripWikilinks`, extract a shared `today-view` parser, cacheable fonts) — without changing existing `--json` fields.

**Architecture:** Land the two refactors first so everything else builds on clean shared code: a single `src/core/wikilink.ts` (replacing 3 forked copies) and a shared `src/surface/today-view.ts` (the `dome.daily.today/v1` parsers + types that the web and terminal renderers currently duplicate). Then the correctness/fidelity fixes consume the shared module; then the web JS (fingerprint + token scrub) and the cacheable font route.

**Tech Stack:** TypeScript on Bun; `bun:test`; the Dome surface/CLI/HTTP layers. `bun run typecheck` must stay 0 (`exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` — use conditional spreads + `!`/guards). `--json`/today-doc existing fields stay byte-stable (additive only).

**Source of truth:** `docs/superpowers/specs/2026-06-14-cockpit-briefing-design.md` + the mock `docs/cohesive/design-assets/cockpit-briefing/briefing.dc.html`.

**Run:** `bun test <path>` · `bun test tests/http tests/cli tests/extensions` · `bun run typecheck`.

---

## File structure
- **Create:** `src/core/wikilink.ts` (the one `stripWikilinks`), `src/surface/today-view.ts` (shared parsers + types).
- **Modify:** `src/cli/presenter/width.ts` (drop local stripWikilinks, re-export from core), `assets/extensions/dome.agent/processors/brief-index.ts` (import from core), `src/http/today-html.ts` (consume shared parsers; grouping; hero day-count; fingerprint; token scrub; font url()), `src/cli/commands/today.ts` (consume shared parsers; count honesty; all-clear), `src/http/server.ts` (font routes), `src/http/today-fonts.ts` (stays the byte source).
- **Tests:** `tests/core/wikilink.test.ts` (new), `tests/surface/today-view.test.ts` (new), `tests/http/today-html.test.ts`, `tests/cli/commands/today.test.ts`, `tests/http/http-server.test.ts`.

---

## Task 1 (#6): consolidate `stripWikilinks` into `src/core/wikilink.ts`

**Files:** Create `src/core/wikilink.ts`; Modify `src/cli/presenter/width.ts`, `src/http/today-html.ts`, `assets/extensions/dome.agent/processors/brief-index.ts`; Test `tests/core/wikilink.test.ts`.

- [ ] **Step 1** Read all three current copies to reconcile behavior: `src/cli/presenter/width.ts:39`, `src/http/today-html.ts:722`, `assets/extensions/dome.agent/processors/brief-index.ts:40` (it drops `.md`; the others don't). Reconcile to the **most thorough** (strip `.md` — harmless when absent, nicer when present).

- [ ] **Step 2** Write `tests/core/wikilink.test.ts`:
```ts
import { stripWikilinks } from "../../src/core/wikilink";
test("alias form keeps the alias", () => {
  expect(stripWikilinks("see [[wiki/x|the X thing]] now")).toBe("see the X thing now");
});
test("bare path → last segment, drops .md", () => {
  expect(stripWikilinks("ref [[wiki/entities/cody-born]] and [[notes/plan.md]]")).toBe("ref cody-born and plan");
});
test("collapses leftover whitespace, trims", () => {
  expect(stripWikilinks("a   [[x]]   b")).toBe("a x b");
});
test("plain text unchanged", () => {
  expect(stripWikilinks("nothing here")).toBe("nothing here");
});
```

- [ ] **Step 3** Run `bun test tests/core/wikilink.test.ts` → FAIL.

- [ ] **Step 4** Implement `src/core/wikilink.ts`:
```ts
// core/wikilink: strip [[wikilink]] markup from display text. The single home
// for this — bundles (assets/extensions), src/cli, and src/surface all import
// it. `[[path|alias]]` → alias; `[[path/to/page.md]]` → last segment (sans .md).
export function stripWikilinks(value: string): string {
  return value
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, (_m, target: string) => {
      const last = target.split("/").pop() ?? target;
      return last.endsWith(".md") ? last.slice(0, -3) : last;
    })
    .replace(/\s+/g, " ")
    .trim();
}
```
Then: in `width.ts` delete the local function and `export { stripWikilinks } from "../../core/wikilink";` (keep the same export name so the presenter barrel still re-exports it — check `src/cli/presenter/index.ts` re-exports width). In `today-html.ts` delete the local `stripWikilinks` (line 722) and import from `../../core/wikilink` (NOTE: today-html.ts "no engine imports" header refers to the engine/runtime — `src/core/wikilink` is a pure leaf util with no engine deps, so this is fine; verify it imports nothing heavy). In `brief-index.ts` delete the local function and import from `../../../../src/core/wikilink` (the bundle CAN import src/core — confirm with the existing `src/core/*` imports in that file, e.g. effect/processor).

- [ ] **Step 5** Run `bun test tests/core/wikilink.test.ts tests/cli tests/http tests/extensions/agent-brief-index.test.ts` + `bun run typecheck` → green. (The `.md`-strip change may shift a brief-index assertion — update it to the reconciled behavior if so.)

- [ ] **Step 6** Commit:
```bash
git add src/core/wikilink.ts src/cli/presenter/width.ts src/http/today-html.ts assets/extensions/dome.agent/processors/brief-index.ts tests/core/wikilink.test.ts
git commit -m "refactor(core): single stripWikilinks in src/core/wikilink (de-fork 3 copies)"
```

---

## Task 2 (#7): extract shared `src/surface/today-view.ts`

**Files:** Create `src/surface/today-view.ts`; Modify `src/http/today-html.ts`, `src/cli/commands/today.ts`; Test `tests/surface/today-view.test.ts`.

- [ ] **Step 1** Read the duplicated parsers/types in BOTH files: `src/http/today-html.ts` (types ~454/574-597, parsers `parseBrief`/`parseCalendar`/`parseHero`/`rows`/`questionRows`/`isRecord` ~601-708) and `src/cli/commands/today.ts` (the mirror types ~295-320 + `parseHero`/`parseTaskRows`/`parseQuestionRows`/`parseBrief`/`parseCalendar`/`isRecord` ~464-568). Note the drift: web strips wikilinks in parsers + parses question `options`; CLI doesn't. The shared module must do BOTH (strip wikilinks via `src/core/wikilink`, parse options) so both surfaces are clean + consistent.

- [ ] **Step 2** Write `tests/surface/today-view.test.ts`:
```ts
import { parseTodayView } from "../../src/surface/today-view";
test("parses tasks with wikilinks stripped + dueDate", () => {
  const v = parseTodayView({ date: "2026-06-14",
    openTasks: [{ text: "talk to [[wiki/x|Eric]]", path: "p", line: 1, dueDate: "2026-06-10" }],
    followups: [], questions: [], counts: { openTasks: 1, followups: 0, questions: 0 }, brief: null, calendar: null, hero: null });
  expect(v.openTasks[0]!.text).toBe("talk to Eric");
  expect(v.openTasks[0]!.dueDate).toBe("2026-06-10");
});
test("parses question options + resolveCommand", () => {
  const v = parseTodayView({ date: "x", openTasks: [], followups: [],
    questions: [{ id: 7, question: "go?", options: ["yes","no"], resolveCommand: "dome resolve 7" }],
    counts: { openTasks: 0, followups: 0, questions: 1 }, brief: null, calendar: null, hero: null });
  expect(v.questions[0]!.options).toEqual(["yes","no"]);
});
test("brief/calendar/hero null-safe", () => {
  const v = parseTodayView({ date: "x", openTasks: [], followups: [], questions: [], counts: {}, brief: null, calendar: null, hero: null });
  expect(v.brief).toBeNull(); expect(v.calendar).toBeNull(); expect(v.hero).toBeNull();
});
```

- [ ] **Step 3** Run → FAIL.

- [ ] **Step 4** Implement `src/surface/today-view.ts`: export the field types (`TodayTaskRow`, `TodayQuestionRow`, `TodayCalendarEvent`, `TodayBriefField`, `TodayHeroItem`) and a single `parseTodayView(data: unknown): TodayView` that returns `{ date, openTasks, followups, questions, brief, calendar, hero, counts }` — folding in the existing parser bodies, with `stripWikilinks` (from `src/core/wikilink`) applied to all task/question/hero text, and `counts` carrying the TRUE totals from the doc's `counts` field (`{openTasks, followups, questions}`, number-coerced). `isRecord` lives here too. Then rewrite both renderers to call `parseTodayView` once and consume `TodayView` — delete their local parsers/types. Keep surface-specific presentation (terminal `truncate`/glyphs/`daysBetween`; web `clampText`/CSS) in the renderers. Honor `exactOptionalPropertyTypes` (conditional spreads) + `noUncheckedIndexedAccess` (`!`/guards).

- [ ] **Step 5** Run `bun test tests/surface/today-view.test.ts tests/http tests/cli/commands/today.test.ts` + `bun run typecheck` → green. The two renderers' existing tests must still pass (their output shouldn't change from this refactor — it's pure extraction). Fix any drift the extraction reconciles (e.g. CLI question text now stripped).

- [ ] **Step 6** Commit:
```bash
git add src/surface/today-view.ts src/http/today-html.ts src/cli/commands/today.ts tests/surface/today-view.test.ts
git commit -m "refactor(surface): shared today-view parser; web + terminal stop duplicating it"
```

---

## Task 3 (#1): count honesty (true totals + accurate "+N more")

**Files:** Modify `src/http/today-html.ts`, `src/cli/commands/today.ts`; Test both their tests.

- [ ] **Step 1** Read how each renderer counts now: terminal `today.ts` verdict uses `counts.*` (true) but `… N more` is `bucketed.length - cap` (display-limited); web `today-html.ts` "Still open" shows `items.length` (display-limited) + no overflow. The shared `TodayView.counts` (Task 2) carries the true totals. The doc also exposes `omitted` (true − shown per source). Use the true totals.

- [ ] **Step 2** Write failing tests:
```ts
// today.test.ts — terminal: "… N more" reflects the TRUE remaining, not the received-list remaining
test("overflow count uses true totals", () => {
  // doc: counts.openTasks = 234, openTasks list (received) = 12, hero null
  const out = formatTodayResult(dataWith234OpenButList12, ASCII_CAPS, "/vault");
  expect(out).toMatch(/2\d\d more|22\d more|23\d more/); // ~227 more, not "5 more"
});
// today-html.test.ts — web: "Still open" count is the true total + has an overflow line
test("web still-open shows true total + a +N more affordance", () => {
  const html = renderTodayHtml({ ...base, counts: { openTasks: 234, followups: 0, questions: 0 } }, { refreshSeconds: 15 });
  expect(html).toContain("234");                 // true count, not the displayed length
  expect(html).toMatch(/more|later/);            // overflow affordance present
});
```

- [ ] **Step 3** Run → FAIL.

- [ ] **Step 4** Implement: in both renderers compute `shownOpen = <rendered task count>` and `trueOpen = counts.openTasks + counts.followups` (the doc's true totals); the overflow = `trueOpen - shownOpen` (clamped ≥ 0). Terminal: `… ${overflow} more · dome today --verbose`. Web: the "Still open" header count = `trueOpen` (the true total), and a trailing `+${overflow} more, later` chip when `overflow > 0` (this dovetails with Task 4's grouping — the far-future/overflow collapse). Do NOT change the doc/`--json`; just read `counts` correctly.

- [ ] **Step 5** Run both tests + `bun run typecheck` → green.

- [ ] **Step 6** Commit:
```bash
git add src/http/today-html.ts src/cli/commands/today.ts tests/
git commit -m "fix(cli,http): today overflow/'+N more' reflect true totals, not the display-limited list"
```

---

## Task 4 (#3): web "Still open" grouping + far-future collapse

**Files:** Modify `src/http/today-html.ts`; Test `tests/http/today-html.test.ts`.

- [ ] **Step 1** Read the mock's long-list state (`briefing.dc.html:234-263`): groups `overdue · N` / `today · N` / `this week · N`, each a short labeled section, then a `+N more, later this month` chip. Read the current flat `renderStillOpenHtml` (`today-html.ts:537`).

- [ ] **Step 2** Write failing tests:
```ts
test("still-open groups by urgency with a far-future collapse chip", () => {
  const mk = (t, due) => ({ text: t, path: "p", line: 1, dueDate: due });
  const html = renderTodayHtml({ ...base, date: "2026-06-14",
    openTasks: [mk("od","2026-06-01"), mk("td","2026-06-14"), mk("wk","2026-06-18"), mk("far","2026-09-01")],
    followups: [], counts: { openTasks: 4, followups: 0, questions: 0 }, hero: null }, { refreshSeconds: 15 });
  expect(html).toMatch(/overdue/i);
  expect(html).toMatch(/today/i);
  expect(html).toMatch(/this week/i);
  expect(html).toMatch(/more, later|later this month/i);   // far-future collapsed
});
```

- [ ] **Step 3** Run → FAIL.

- [ ] **Step 4** Implement `renderStillOpenHtml` grouping: bucket items into `overdue` (dueDate < today), `today` (== today), `this week` (within 7 days), and `later` (> 7 days OR undated). Render overdue/today/this-week as small labeled groups (`<h3 class="bucket">overdue · N</h3>` + the item rows). Collapse `later` to a single `+N more, later` chip (matching the mock). Keep the `.reveal`/source-on-hover + glyphs. The group labels use the same status colors (overdue red, today yellow, this-week muted). Keep escaping via `esc()`.

- [ ] **Step 5** Run + typecheck → green. Eyeball via `dome http` + screenshot (work vault; it has overdue + open tasks so groups render).

- [ ] **Step 6** Commit:
```bash
git add src/http/today-html.ts tests/http/today-html.test.ts
git commit -m "feat(http): /today 'Still open' grouped by urgency + far-future collapse (never a wall)"
```

---

## Task 5 (#5 + #4): web hero day-count + terminal all-clear two-line

**Files:** Modify `src/http/today-html.ts`, `src/cli/commands/today.ts`; Test both.

- [ ] **Step 1** Read web `renderHeroHtml` (it emits bare `overdue` — `today-html.ts` ~464) and terminal's `daysBetween` helper (`today.ts` ~376) + the all-clear branch (`today.ts:401` gates the whole body behind `!isAllClear`).

- [ ] **Step 2** Failing tests:
```ts
// web: hero shows "overdue Nd"
test("web hero shows the overdue day count", () => {
  const html = renderTodayHtml({ ...base, date: "2026-06-14",
    hero: { kind: "task", item: { text: "x", path: "p", line: 1, dueDate: "2026-06-10" } } }, { refreshSeconds: 15 });
  expect(html).toMatch(/overdue\s*4d/);
});
// terminal: all-clear is the calm two-line state
test("terminal all-clear renders the calm two-line body", () => {
  const out = formatTodayResult({ date: "2026-06-14", openTasks: [], followups: [], questions: [], counts: { openTasks: 0, followups: 0, questions: 0 }, brief: null, calendar: null, hero: null }, ASCII_CAPS, "/vault");
  expect(out).toMatch(/all clear/);
  expect(out).toMatch(/nothing open|inbox/i);
  expect(out).toMatch(/go make something|you're clear/i);
});
```

- [ ] **Step 3** Run → FAIL.

- [ ] **Step 4** Implement: web `renderHeroHtml` — when `dueDate < today`, render `overdue ${daysBetween(dueDate, today)}d` (port the small `daysBetween` into `src/surface/today-view.ts` or a shared date util so both surfaces share it; it's a pure date diff). Terminal — in the `isAllClear` branch, after the verdict header, push the calm two-line body: `  ${paint(statusGlyph("muted",caps),"muted",caps)} nothing open · inbox empty` and `  ${paint("you're clear. go make something.","muted",caps)}` (match the mock's wording/spec).

- [ ] **Step 5** Run both + typecheck → green.

- [ ] **Step 6** Commit:
```bash
git add src/http/today-html.ts src/cli/commands/today.ts src/surface/today-view.ts tests/
git commit -m "fix(cli,http): web hero shows overdue Nd; terminal all-clear is the calm two-line state"
```

---

## Task 6 (#2 + #9 token-scrub): web JS fingerprint + token hygiene

**Files:** Modify `src/http/today-html.ts`; Test `tests/http/today-html.test.ts`.

- [ ] **Step 1** Read the inline JS `fingerprint` (`today-html.ts:316` — `JSON.stringify(data)` over the whole doc) and the token read (`location.search` ~264).

- [ ] **Step 2** Failing tests (assert the shipped JS text):
```ts
test("poll fingerprint excludes volatile attention/lastChangedAt fields", () => {
  const html = renderTodayHtml(base, { refreshSeconds: 15 });
  // fingerprint should project visible fields, not stringify the whole doc
  expect(html).not.toContain("return JSON.stringify(data);");
  expect(html).toMatch(/fingerprint/);
});
test("token is scrubbed from the URL after read", () => {
  const html = renderTodayHtml(base, { refreshSeconds: 15 });
  expect(html).toContain("history.replaceState");
});
```

- [ ] **Step 3** Run → FAIL.

- [ ] **Step 4** Implement in the inline JS: change `fingerprint(data)` to project only user-visible fields — e.g. `JSON.stringify({ b: data.brief && data.brief.text, h: data.hero, o: (data.openTasks||[]).map(t=>[t.text,t.dueDate]), f: (data.followups||[]).map(t=>[t.text,t.dueDate]), q: (data.questions||[]).map(x=>[x.id,x.question]), c: data.counts, cal: data.calendar })` (exclude `attention`/`lastChangedAt`/`impressions`). After reading the token from `location.search`, scrub it: `if (token) { var u = new URL(location.href); u.searchParams.delete("token"); history.replaceState(null, "", u.pathname + u.search + u.hash); }` (keep `token` in the JS closure for the Bearer header). Keep all other JS behavior.

- [ ] **Step 5** Run + typecheck → green. Eyeball: open the page, confirm no reload-flash on idle polls, and the URL loses `?token=` after load while resolve/capture still authorize.

- [ ] **Step 6** Commit:
```bash
git add src/http/today-html.ts tests/http/today-html.test.ts
git commit -m "fix(http): narrow poll fingerprint (no spurious reloads); scrub ?token= from the URL"
```

---

## Task 7 (#8): serve fonts from a cacheable route

**Files:** Modify `src/http/server.ts`, `src/http/today-html.ts`; Test `tests/http/http-server.test.ts`.

- [ ] **Step 1** Read the `GET /today` handler + the `no-store` header (`server.ts:232`+, ~252) and the `@font-face` `data:` URIs in `today-html.ts` (the `FONT_FACE` const using the base64 consts).

- [ ] **Step 2** Failing tests (in http-server tests, which spin the real server):
```ts
test("GET /today/fonts/basel-book.woff2 returns the font with an immutable long cache", async () => {
  const res = await fetch(`${base}/today/fonts/basel-book.woff2`, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("font/woff2");
  expect(res.headers.get("cache-control")).toMatch(/immutable|max-age=\d{6,}/);
});
test("/today HTML references font routes, not megabytes of base64", async () => {
  const res = await fetch(`${base}/today?token=${token}`);
  const html = await res.text();
  expect(html).toContain("/today/fonts/basel-book.woff2");
  expect(html).not.toContain("data:font/woff2;base64,");
  expect(html.length).toBeLessThan(60000); // ~25KB, not ~270KB
});
```

- [ ] **Step 3** Run → FAIL.

- [ ] **Step 4** Implement: add `case "GET /today/fonts/basel-book.woff2"` + `"...basel-medium.woff2"` in server.ts that decode the base64 from `today-fonts.ts` (`Buffer.from(BASEL_BOOK_WOFF2_B64, "base64")`) and return them with `content-type: font/woff2` + `cache-control: public, max-age=31536000, immutable`. These routes require the bearer token like the others (or are token-gated same as `/today`'s query-token — match `/today`'s auth posture; simplest: accept the bearer header, and since the page fetches them via `<link>`/CSS the browser won't send the header — so these font routes should be allowed WITHOUT auth, OR use the query-token. Decide: serve fonts UNAUTHENTICATED (they're non-sensitive static assets) — document that in http-surface. Confirm the server's auth gate can exempt `/today/fonts/*`.). In `today-html.ts`, change `FONT_FACE` to `@font-face { ... src: url("/today/fonts/basel-book.woff2") format("woff2") }` (drop the base64 `data:` URIs). Keep `today-fonts.ts` as the byte source for the routes.

- [ ] **Step 5** Run the http-server tests + `bun run typecheck` → green. Eyeball: `dome http` + load `/today`, confirm Basel still renders (fonts fetched from the routes) and the HTML response is ~25KB.

- [ ] **Step 6** Commit:
```bash
git add src/http/server.ts src/http/today-html.ts tests/http/http-server.test.ts
git commit -m "perf(http): serve Basel fonts from a cacheable route; /today HTML drops to ~25KB"
```

---

## Task 8: verify + doc sync

**Files:** Modify `docs/wiki/specs/http-surface.md`, `docs/superpowers/specs/2026-06-14-cockpit-briefing-design.md`.

- [ ] **Step 1** `bun run typecheck` → exit 0.

- [ ] **Step 2** `bun test 2>&1 | tail -30`. Fix any stale assertions to the new shapes; any `--json`/today-doc existing-field change is a bug (fix code, not test). Re-run until green (modulo confirmed-isolation-passing flakes — `runStatus` heartbeat / `runInit` slack).

- [ ] **Step 3** Hand-walk: `bin/dome today --vault ~/vaults/work` (+ `--verbose`) — confirm the `… N more` true count + the all-clear two-line (use an empty fixture or `--date` with no tasks). `dome http --vault ~/vaults/work --port 3710 --token t` then `curl`/screenshot `/today?token=t` — confirm grouped "Still open" + far-future chip, hero `overdue Nd`, HTML ~25KB, fonts load from the route, no `?token=` left in the URL after load.

- [ ] **Step 4** Doc sync: `http-surface.md` — document the `GET /today/fonts/*` cacheable routes + their auth posture, and the fingerprint/token-scrub behavior; the design spec — note the web grouping + count-honesty now match. Update the `daily-surface`/`cli.md` only if output shapes documented there changed.

- [ ] **Step 5** Commit:
```bash
git add -A
git commit -m "test+docs: cockpit review fixes — full suite green; sync http-surface/spec"
```

---

## Self-review notes
- **Coverage:** #6 (T1) · #7 (T2) · #1 (T3) · #3 (T4) · #5+#4 (T5) · #2+#9-token (T6) · #8 (T7) · verify+docs (T8). The optional #9 inline-JS split is folded as "if it grows" — not a separate task (the JS shrinks anyway once fonts leave the HTML). All findings mapped.
- **Sequencing:** refactors (T1, T2) first so T3–T7 build on `src/core/wikilink` + `src/surface/today-view`. T3 (counts) feeds T4 (the overflow chip).
- **Type consistency:** `stripWikilinks` (core), `parseTodayView`/`TodayView`/`TodayTaskRow`/`TodayQuestionRow`/`TodayCalendarEvent`/`TodayBriefField`/`TodayHeroItem` (surface), `daysBetween` (shared in surface). Reused by name across T2–T7. Conditional spreads for `exactOptionalPropertyTypes`; `!`/guards for `noUncheckedIndexedAccess`.
- **`--json` safety:** no task changes today-doc fields; renderers read `counts` (already present). T8 step 2 guards existing-field stability.
- **Auth nuance (T7):** font routes must be browser-loadable from CSS (no Authorization header) → serve `/today/fonts/*` unauthenticated as non-sensitive static assets; documented in T8.
