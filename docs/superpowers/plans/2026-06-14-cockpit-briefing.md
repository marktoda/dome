# Cockpit "Briefing" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the `/today` web cockpit and `dome today` terminal view to the approved "Briefing" design — a warm narrative brief + calendar + interactive questions + open tasks — sourced via Dome's fact contracts, with the visual surfaces landing first (null-safe) and the agent-emitted facts (brief, calendar) added after.

**Architecture:** The `dome.daily.today` view stays **pure fact-assembly** (it reads `ctx.projection.facts(...)` + `projection.questions`, never foreign markdown). It gains additive `brief`/`calendar`/`hero` fields. `dome.agent` owns two new adoption extractors that emit `dome.agent.brief` and `dome.agent.calendar.event` facts from its own brief block + the foreground-fed `sources/calendar/<date>.md`. The web renderer (`src/http/today-html.ts`) is rewritten to the Briefing visual with JS interval polling + answer-via-`POST /resolve` + capture-via-`POST /capture`; the terminal renderer reuses the v2 presenter.

**Tech Stack:** TypeScript on Bun; `bun:test`; the Dome processor/effect/projection model; `src/core/generated-block.ts` (block markers); `src/cli/presenter/` (terminal); plain HTML/CSS/JS (self-contained page). `bun run typecheck` must stay green (`exactOptionalPropertyTypes: true` — omit optional keys via conditional spread).

**Spec:** `docs/superpowers/specs/2026-06-14-cockpit-briefing-design.md`
**Design bundle:** `docs/cohesive/design-assets/cockpit-briefing/briefing.dc.html` (the visual target — read it).

**Run tests:** `bun test <path>` · `bun test tests/extensions tests/http tests/cli` · `bun run typecheck`.

---

## File structure

**Phase 1 — visual surfaces (null-safe):**
- `assets/extensions/dome.daily/processors/action-state.ts` + `today.ts` — add `brief`/`calendar`/`hero` to the doc; hero computed from existing facts; brief/calendar null for now.
- `src/http/today-html.ts` — full rewrite to the Briefing visual (renders fields when present, omits when null); then JS polling + interactivity.
- `src/cli/commands/today.ts` — restyle to the v2 presenter.

**Phase 2 — the facts:**
- `assets/extensions/dome.agent/processors/brief.ts` + `lib/brief-shared.ts` — add the `dome.agent.brief:today` narrative block.
- `assets/extensions/dome.agent/processors/brief-index.ts` (new) — adoption extractor → `dome.agent.brief` fact.
- `assets/extensions/dome.agent/processors/calendar-index.ts` (new) — adoption extractor → `dome.agent.calendar.event` facts.
- `assets/extensions/dome.agent/manifest.yaml` — register the two extractors + grants.
- `action-state.ts`/`today.ts` — wire `brief`/`calendar` fields to read the new facts.

**Phase 3 — integration:**
- `docs/wiki/specs/daily-surface.md`, `docs/wiki/specs/http-surface.md`, `docs/wiki/specs/cli.md` — sync.

**Tests:** `tests/extensions/daily-today.*`, `tests/extensions/agent-brief*.test.ts`, `tests/http/today-html.test.ts`, `tests/cli/commands/today.test.ts`, plus new extractor tests.

---

## Task 1: today view — add `hero` + null-safe `brief`/`calendar` fields

**Files:** Modify `assets/extensions/dome.daily/processors/action-state.ts`, `today.ts`; Test `tests/extensions/` (find the today-view test; e.g. `daily-today.test.ts` or similar — grep `dome.daily.today` in tests).

- [ ] **Step 1: Read** `action-state.ts` (the `DailyActionState` type, `collectDailyActionState`, `DailyTaskItem` incl. its `attention`/`dueDate`/`priority` fields, `DailyQuestionItem` incl. `automationPolicy`) and `today.ts` (the `data` object). Find the existing today-view test file (`grep -rln "dome.daily.today\|collectDailyActionState" tests`).

- [ ] **Step 2: Write failing tests** for a new pure `selectHero` function + the doc fields. Add to the today-view test (or a new `tests/extensions/daily-hero.test.ts`):

```ts
import { selectHero } from "../../assets/extensions/dome.daily/processors/action-state";

const task = (over: Partial<DailyTaskItem>): DailyTaskItem => ({
  text: "t", path: "p", line: 1, source: "daily", followup: false,
  dueDate: null, priority: null, lastChangedAt: null, attention: null,
  evidenceLabel: "p", sourceRefs: [], ...over,
});

test("hero picks the most-urgent non-discounted overdue task", () => {
  const a = task({ text: "old zombie", dueDate: "2026-01-01", attention: { discount: 0.95, impressions: 40, lastShown: "x" } });
  const b = task({ text: "due-ish", dueDate: "2026-06-10", priority: "high" });
  const hero = selectHero({ openTasks: [a, b], questions: [], today: "2026-06-14" });
  expect(hero).toEqual({ kind: "task", item: b }); // zombie discounted out
});
test("hero falls back to an owner-needed question when no overdue task", () => {
  const q = { id: 7, question: "blocker?", options: ["yes","no"], resolveCommand: "dome resolve 7", metadata: null, automationPolicy: "owner-needed", path: "p", line: null, source: "daily", lastChangedAt: null, evidenceLabel: "p", sourceRefs: [] } as DailyQuestionItem;
  const hero = selectHero({ openTasks: [], questions: [q], today: "2026-06-14" });
  expect(hero).toEqual({ kind: "question", item: q });
});
test("hero is null when nothing qualifies", () => {
  expect(selectHero({ openTasks: [], questions: [], today: "2026-06-14" })).toBeNull();
});
```

- [ ] **Step 3: Run** → FAIL (`selectHero` undefined).

- [ ] **Step 4: Implement** in `action-state.ts`:

```ts
export type DailyHero =
  | { readonly kind: "task"; readonly item: DailyTaskItem }
  | { readonly kind: "question"; readonly item: DailyQuestionItem };

const DISCOUNT_FLOOR = 0.5; // tasks discounted at/above this are not hero-eligible

export function selectHero(input: {
  readonly openTasks: ReadonlyArray<DailyTaskItem>;
  readonly questions: ReadonlyArray<DailyQuestionItem>;
  readonly today: string;
}): DailyHero | null {
  const eligible = input.openTasks.filter(
    (t) => (t.attention?.discount ?? 0) < DISCOUNT_FLOOR,
  );
  const overdue = eligible
    .filter((t) => t.dueDate !== null && t.dueDate < input.today)
    .sort((a, b) => heroTaskRank(b) - heroTaskRank(a));
  if (overdue[0] !== undefined) return { kind: "task", item: overdue[0] };
  const ownerQ = input.questions.find((q) => q.automationPolicy === "owner-needed");
  if (ownerQ !== undefined) return { kind: "question", item: ownerQ };
  const soonest = eligible
    .filter((t) => t.dueDate !== null)
    .sort((a, b) => (a.dueDate! < b.dueDate! ? -1 : 1));
  if (soonest[0] !== undefined) return { kind: "task", item: soonest[0] };
  return null;
}

const PRIORITY_WEIGHT: Record<string, number> = {
  highest: 5, high: 4, medium: 3, low: 2, lowest: 1,
};
function heroTaskRank(t: DailyTaskItem): number {
  return (t.priority ? PRIORITY_WEIGHT[t.priority] ?? 0 : 0); // priority-weighted, not raw overdue-days
}
```

Then in `today.ts`, add to the `data` object (after computing `openTasks`/`questions`):
```ts
const hero = selectHero({ openTasks, questions, today: actionState.date });
// ...in data:
brief: null,        // wired to the dome.agent.brief fact in Task 8
calendar: null,     // wired to dome.agent.calendar.event facts in Task 9
...(hero !== null ? { hero } : { hero: null }),
```
Add the `DailyHero` (and `brief`/`calendar` field) types to the document's TS type. Keep existing fields untouched.

- [ ] **Step 5: Run** the today-view tests + `bun run typecheck` → green. Confirm `--json`/structured doc still has all existing fields (a snapshot/JSON test, if present, only GAINS `brief`/`calendar`/`hero`).

- [ ] **Step 6: Commit**
```bash
git add assets/extensions/dome.daily/processors/action-state.ts assets/extensions/dome.daily/processors/today.ts tests/extensions/
git commit -m "feat(daily): today view gains hero (discount-aware) + null-safe brief/calendar fields"
```

---

## Task 2: web cockpit — rewrite `today-html.ts` to the Briefing visual (static)

**Files:** Modify `src/http/today-html.ts`; Test `tests/http/today-html.test.ts`

- [ ] **Step 1: Read** the design target `docs/cohesive/design-assets/cockpit-briefing/briefing.dc.html` (the phone + desktop layouts, the tokens, the section order) and the current `src/http/today-html.ts` (its `renderTodayHtml(data, opts)` signature + existing tests). Note the doc fields now available: `date`, `brief` (null), `calendar` (null), `hero` (maybe), `openTasks`, `followups`, `questions`, `counts`, `dueCounts`.

- [ ] **Step 2: Write failing tests** in `today-html.test.ts` asserting the Briefing structure + null-safety + escaping (adapt to the existing harness):
```ts
test("renders brief + provenance when brief present", () => {
  const html = renderTodayHtml({ ...base, brief: { text: "Today is about X.", sourceRef: { path: "wiki/dailies/2026-06-14.md", lines: null, commit: "abc" } } }, { refreshSeconds: 15 });
  expect(html).toContain("Today is about X.");
  expect(html).toContain("· brief");
});
test("omits brief, calendar, hero sections when null", () => {
  const html = renderTodayHtml({ ...base, brief: null, calendar: null, hero: null, openTasks: [], followups: [], questions: [] }, { refreshSeconds: 15 });
  expect(html).toContain("You're clear");        // all-clear state
});
test("renders the hero pill when hero is a task", () => {
  const html = renderTodayHtml({ ...base, hero: { kind: "task", item: taskFixture } }, { refreshSeconds: 15 });
  expect(html).toContain(taskFixture.text);
});
test("escapes HTML in all content", () => {
  const html = renderTodayHtml({ ...base, brief: { text: "<script>x</script>", sourceRef: ref } }, { refreshSeconds: 15 });
  expect(html).not.toContain("<script>x");
});
```

- [ ] **Step 3: Run** → FAIL.

- [ ] **Step 4: Implement** the rewrite. Reproduce the Briefing layout (read the .dc.html for exact structure/spacing) with **system fonts** and these tokens: bg `#0b0b0c` + radial dot-grid; surfaces `#131313`; cards `#1A1A1A`; status `ok #21C95E`, `warn #FFBF17`, `err #FF593C`, `q #3ADCFF`; muted whites; accent `#FF37C7` on the brand dot + the single hero pill ONLY; fonts sans `-apple-system, system-ui, sans-serif`, mono `ui-monospace, "SF Mono", Menlo, monospace`. Responsive: single column; a `@media (min-width: 900px)` widens to the two-column band (calendar | needs-you) + still-open two-column. Sections in order: header (date + "Good morning." + live dot) → brief (+`↳ <path> · brief`) → hero pill → On your calendar → Dome needs you (questions; render `<details>` reveal of `resolveCommand` for now) → Still open (glyph-led, `.src` revealed on hover). Omit any section whose data is null/empty. Edge states from data: all-clear ("You're clear."), single item, long list (group overdue/today/this-week + "+N more"). Keep it a pure function; keep the existing `esc()` HTML-escaper and escape ALL interpolated content. Keep `<meta http-equiv="refresh">` for now (JS polling lands in Task 3).

- [ ] **Step 5: Run** `bun test tests/http/today-html.test.ts` → PASS. `bun run typecheck` → green. Eyeball via `dome http --vault docs --token t` + open `http://127.0.0.1:3663/today?token=t` (sync the docs vault first if needed).

- [ ] **Step 6: Commit**
```bash
git add src/http/today-html.ts tests/http/today-html.test.ts
git commit -m "feat(http): rewrite /today to the Briefing visual (static, null-safe)"
```

---

## Task 3: web cockpit — JS polling + interactivity (resolve + capture + live/stale)

**Files:** Modify `src/http/today-html.ts`; Test `tests/http/today-html.test.ts`

- [ ] **Step 1: Write failing tests** asserting the page ships interactivity JS that polls `/tasks`, posts to `/resolve`/`/capture` with the bearer header, and reads the token:
```ts
test("page includes JS that polls /tasks and reads the token from the query", () => {
  const html = renderTodayHtml(base, { refreshSeconds: 15 });
  expect(html).toContain("/tasks");
  expect(html).toMatch(/Authorization.*Bearer/);
  expect(html).toContain("location.search");
});
test("question options post to /resolve; capture posts to /capture", () => {
  const html = renderTodayHtml({ ...base, questions: [questionFixture] }, { refreshSeconds: 15 });
  expect(html).toContain("/resolve");
  expect(html).toContain("/capture");
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**: replace `<meta refresh>` with an inline `<script>` that: reads `token` from `location.search`; polls `GET /tasks` every `refreshSeconds` with `Authorization: Bearer <token>`; on success re-renders the dynamic regions (or simplest: reloads data and updates the DOM; a full client re-render is acceptable — keep it small and dependency-free); on fetch failure shows the stale/reconnecting banner holding last-known content; wires question option buttons to `POST /resolve {id,value}` (optimistic remove + suppress re-show of answered ids until a clean poll) with a reveal-command fallback; wires a "+ capture a thought" box to `POST /capture {text}`. All POSTs send the bearer header. Keep the whole script inline + dependency-free (self-contained page). Server-render stays the source of the initial paint (so no-JS still shows content).

- [ ] **Step 4: Run** tests + `bun run typecheck` → green. Eyeball: answer a question from the browser, add a capture, kill `dome http` to see the reconnecting state.

- [ ] **Step 5: Commit**
```bash
git add src/http/today-html.ts tests/http/today-html.test.ts
git commit -m "feat(http): /today JS polling + answer/capture interactivity + live/stale states"
```

---

## Task 4: terminal `dome today` — restyle to the v2 presenter

**Files:** Modify `src/cli/commands/today.ts`; Test `tests/cli/commands/today.test.ts`

- [ ] **Step 1: Read** `src/cli/commands/today.ts` (current renderer) and a v2-restyled command (e.g. `src/cli/commands/check.ts`) for the verdict-header + `signalLine` + glyph patterns. Note the doc now carries `hero`, `calendar`, `brief`.

- [ ] **Step 2: Write failing tests** (reuse harness):
```ts
test("today is verdict-first with a hero line and grouped tasks; no dome decide", () => {
  expect(out).toMatch(/today · .*(overdue|open|all clear)/);
  expect(out).toContain("→");                 // hero action line
  expect(out).not.toContain("dome decide");
});
test("full brief + source paths only under --verbose", () => {
  expect(defaultOut).not.toContain(briefText);
  expect(verboseOut).toContain(briefText);
});
```

- [ ] **Step 3: Implement** the restyle using the v2 presenter: verdict header (`✗ N overdue · M open` / `✓ all clear`); one `→` hero line (task text, or `dome resolve <id>` when the hero is a question; omit when `hero` null; never `dome decide`); a one-line calendar summary when `calendar` present; glyph-grouped tasks (`✗` overdue / `⚠` today / `•` open); a single `? ask` line with the resolve command; `✓ everything else clear`. Move the full brief prose + source paths behind `--verbose` (the command already has the v2 `--verbose` flag plumbed). Leave the `--json` branch untouched.

- [ ] **Step 4: Run** `bun test tests/cli/commands/today.test.ts` + `bun run typecheck` → green. Eyeball `bin/dome today --vault docs` + `--verbose`.

- [ ] **Step 5: Commit**
```bash
git add src/cli/commands/today.ts tests/cli/commands/today.test.ts
git commit -m "feat(cli): dome today restyled to the Briefing terminal (v2 presenter, hero, no dome decide)"
```

---

## Task 5: `dome.agent.brief:today` narrative block

**Files:** Modify `assets/extensions/dome.agent/processors/brief.ts`, `assets/extensions/dome.agent/lib/brief-shared.ts`; Test the brief test (`grep -rln "dome.agent.brief\|brief-shared" tests`).

- [ ] **Step 1: Read** `brief.ts` + `brief-shared.ts` to learn the existing block convention: how block markers are defined (`generatedBlockMarkers(owner, block)`), how blocks are composed into `## Start Here`, the grounding pass (wikilink enforcement → ungrounded stripped to questions), the degradation ladder, and the model-invocation seam (`ctx.modelInvoke.step`). Identify how to add a new block named `today` (`dome.agent.brief:today`) spliced at the TOP of `## Start Here`, above the yesterday block.

- [ ] **Step 2: Write a failing test** (reuse the brief test harness, which mocks the model): assert that when the model returns a grounded narrative, a `dome.agent.brief:today` block is spliced at the top of `## Start Here`; that ungrounded sentences are stripped (grounding reused); and that when the model is unavailable the block is omitted (no fallback prose).

- [ ] **Step 3: Run** → FAIL.

- [ ] **Step 4: Implement** the new block following the existing block pattern exactly (shared markers via `generatedBlockMarkers("dome.agent", "today")` or the file's convention; reuse the grounding + degradation helpers). The prompt asks the model for a warm, forward-looking 2–3 sentence framing of today, grounded with `[[wikilinks]]`. Splice at the top of `## Start Here`. Compose it in the same 05:30 pass + wake-tick as the other blocks (no new trigger).

- [ ] **Step 5: Run** the brief tests + `bun run typecheck` → green.

- [ ] **Step 6: Commit**
```bash
git add assets/extensions/dome.agent/processors/brief.ts assets/extensions/dome.agent/lib/brief-shared.ts tests/
git commit -m "feat(agent): dome.agent.brief:today — forward narrative block atop Start Here"
```

---

## Task 6: brief fact extractor → `dome.agent.brief` fact

**Files:** Create `assets/extensions/dome.agent/processors/brief-index.ts`; Modify `assets/extensions/dome.agent/manifest.yaml`; Test `tests/extensions/agent-brief-index.test.ts` (new).

- [ ] **Step 1: Read** `assets/extensions/dome.daily/processors/task-index.ts` (the adoption-extractor template) + `src/core/generated-block.ts` (`findGeneratedBlock`, `extractGeneratedBlockBody`) + how `dome.agent`'s manifest registers an adoption processor + grants. Find the daily-note path settings (so the extractor knows which paths are daily notes) and the `dome.agent.brief:today` block id from Task 5.

- [ ] **Step 2: Write a failing test** (`tests/extensions/agent-brief-index.test.ts`): given an adopted daily note containing a `dome.agent.brief:today` block with body `Today is about [[wiki/x]] and stuff.`, the extractor emits one `factEffect` with `predicate: "dome.agent.brief"`, `object.value` = the plain text with wikilinks stripped (`Today is about x and stuff.`), and a `sourceRef` to the block; given a note without the block, it emits nothing.

- [ ] **Step 3: Run** → FAIL.

- [ ] **Step 4: Implement** `brief-index.ts` mirroring `task-index.ts`: iterate `ctx.changedPaths`, restrict to daily-note paths, `ctx.snapshot.readFile`, locate the block via `findGeneratedBlock`/`extractGeneratedBlockBody`, strip `[[path|alias]]`→`alias` and `[[path]]`→last path segment (a small pure `stripWikilinks` helper, unit-tested) + collapse whitespace, and emit:
```ts
factEffect({
  subject: { kind: "page", path },
  predicate: "dome.agent.brief",
  object: { kind: "string", value: plainText },
  assertion: "extracted",
  sourceRefs: [ctx.sourceRef(path, blockLineRange, briefStableId(path))],
})
```
Register it in `manifest.yaml` (adoption phase, signal trigger on daily paths) with a `read` grant covering the daily notes. Add a `read` grant + the processor entry; follow the manifest shape of an existing adoption processor.

- [ ] **Step 5: Run** the new test + `bun test tests/extensions` + `bun run typecheck` → green (the manifest/grant must satisfy the capability checks — if a grant is missing, `dome doctor` would flag `capability.grant-*`; ensure the grant covers the read).

- [ ] **Step 6: Commit**
```bash
git add assets/extensions/dome.agent/processors/brief-index.ts assets/extensions/dome.agent/manifest.yaml tests/extensions/agent-brief-index.test.ts
git commit -m "feat(agent): brief-index adoption extractor emits dome.agent.brief fact"
```

---

## Task 7: calendar fact extractor → `dome.agent.calendar.event` facts

**Files:** Create `assets/extensions/dome.agent/processors/calendar-index.ts`; Modify `manifest.yaml`; Test `tests/extensions/agent-calendar-index.test.ts` (new).

- [ ] **Step 1: Read** `assets/extensions/dome.agent/lib/brief-shared.ts` for the existing defensive calendar parser (time/title/attendees, the 20-cap) and the `sources/calendar/<date>.md` shape. Reuse that parser — do NOT write a second one.

- [ ] **Step 2: Write a failing test**: given an adopted `sources/calendar/2026-06-14.md` with two events, the extractor emits two `dome.agent.calendar.event` facts whose `object.value` encodes `time | title | meta` (stable, parseable), with sourceRefs to the file; given no file, nothing.

- [ ] **Step 3: Run** → FAIL.

- [ ] **Step 4: Implement** `calendar-index.ts`: iterate `ctx.changedPaths` restricted to `sources/calendar/*.md`, parse via the shared parser, emit one fact per event:
```ts
factEffect({
  subject: { kind: "page", path },
  predicate: "dome.agent.calendar.event",
  object: { kind: "string", value: `${time}\t${title}\t${meta ?? ""}` },
  assertion: "extracted",
  sourceRefs: [ctx.sourceRef(path, lineRange(event.line), calendarEventStableId(path, event))],
})
```
Register in `manifest.yaml` (adoption, signal on `sources/calendar/*`) with the read grant. (The view will decode `time\ttitle\tmeta` in Task 8.)

- [ ] **Step 5: Run** the new test + `bun test tests/extensions` + `bun run typecheck` → green.

- [ ] **Step 6: Commit**
```bash
git add assets/extensions/dome.agent/processors/calendar-index.ts assets/extensions/dome.agent/manifest.yaml tests/extensions/agent-calendar-index.test.ts
git commit -m "feat(agent): calendar-index adoption extractor emits dome.agent.calendar.event facts"
```

---

## Task 8: wire the view's `brief` + `calendar` fields to the facts

**Files:** Modify `assets/extensions/dome.daily/processors/action-state.ts`, `today.ts`; Test the today-view test.

- [ ] **Step 1: Write failing tests**: with `dome.agent.brief` + `dome.agent.calendar.event` facts present in the projection fixture, the today doc's `brief` is `{ text, sourceRef }` and `calendar` is `{ events:[{time,title,meta}], sourceRef }`; with neither, both are `null`.

- [ ] **Step 2: Run** → FAIL (fields are still hardcoded null from Task 1).

- [ ] **Step 3: Implement** in `collectDailyActionState`/`today.ts`: read `ctx.projection.facts({ predicate: "dome.agent.brief" })` → take the one for today's daily path → `brief = { text: literalToString(fact.object), sourceRef: fact.sourceRefs[0] }` (else null). Read `ctx.projection.facts({ predicate: "dome.agent.calendar.event" })` → decode each `time\ttitle\tmeta` → `calendar = { events, sourceRef }` (else null). Replace the hardcoded `null`s from Task 1. The view still does NO markdown parsing — only fact reads.

- [ ] **Step 4: Run** today-view tests + `bun test tests/extensions` + `bun run typecheck` → green. Eyeball `bin/dome today --vault docs` (after a sync that runs the extractors) and the web page — brief + calendar now appear when facts exist.

- [ ] **Step 5: Commit**
```bash
git add assets/extensions/dome.daily/processors/action-state.ts assets/extensions/dome.daily/processors/today.ts tests/extensions/
git commit -m "feat(daily): today view assembles brief + calendar from agent facts (no markdown parsing)"
```

---

## Task 9: spec sync + full-suite verification

**Files:** Modify `docs/wiki/specs/daily-surface.md`, `docs/wiki/specs/http-surface.md`, `docs/wiki/specs/cli.md`.

- [ ] **Step 1:** `bun run typecheck` → MUST exit 0.

- [ ] **Step 2:** `bun test 2>&1 | tail -30`. Classify failures: stale assertions on the old today output → update to the Briefing shape; `--json` failures on the today doc → must be additive-only (existing fields unchanged) — if an existing field changed, that's a bug to fix, not a test to update. Re-run until green (modulo confirmed-isolation-passing flakes; verify with `bun test <file>`).

- [ ] **Step 3:** Hand-walk: `bin/dome today --vault docs` + `--verbose`; `dome http --vault docs --token t` then open `/today?token=t` (sync first). Confirm: Briefing layout, brief/calendar/hero when present + omitted when not, all-clear state, interactivity (answer + capture), reconnecting state.

- [ ] **Step 4:** Update the specs: `daily-surface.md` — add the `dome.agent.brief:today` block row (owner dome.agent, in `## Start Here`); `http-surface.md` — document that `/today` now polls + that the query-token authorizes mutations (resolve/capture) as an accepted loopback/trusted-LAN trust boundary; `cli.md` — the new `dome today` output shape. Add rows for the `dome.agent.brief` + `dome.agent.calendar.event` fact predicates wherever fact predicates are catalogued.

- [ ] **Step 5: Commit**
```bash
git add -A
git commit -m "docs: sync daily-surface/http-surface/cli for the Briefing cockpit; full-suite green"
```

---

## Self-review notes

- **Spec coverage:** fact-based contracts (T6/T7/T8 — view reads facts, extractors emit them) · brief block (T5) · calendar best-effort (T7/T8, omit when absent) · hero discount-aware + optional (T1) · drop keeping-in-mind (absent by construction) · web Briefing visual (T2) · JS polling + answer/capture + live/stale (T3) · query-token trust boundary (T9 docs) · terminal restyle + no dome decide + brief-under-verbose (T4) · sequencing visual-first/null-safe (T1–T4 before T5–T8) · additive `--json` (T1/T8 + T9 guard) · enforcement (T5 daily-surface row, T6/T7 fact-contract tests, T9). All spec sections map to a task.
- **Structure-ownership invariant:** the view (T1/T8) only reads facts + questions; T6/T7 keep all markdown/file parsing inside `dome.agent`. No consumer parses foreign markdown.
- **Type consistency:** `DailyHero`, `selectHero(...)`, `brief: {text,sourceRef}|null`, `calendar: {events:[{time,title,meta}],sourceRef}|null`, predicates `dome.agent.brief` / `dome.agent.calendar.event`, `stripWikilinks` — defined in T1/T6/T7 and reused by name in T8. `exactOptionalPropertyTypes` honored via conditional spreads.
- **`--json` safety:** T1 + T8 only add fields; T9 step 2 guards existing-field stability and treats any other change as a bug.
- **New processors need manifest + grant** (T6/T7) — if a grant is missing, `dome doctor` flags `capability.grant-*`; the tasks call this out.
