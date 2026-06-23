# today view enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the morning brief by default, render the calendar agenda, paint all-five priority markers, and retire the forced hero in `dome today` (and the HTTP cockpit), routing every change through the shared view-model.

**Architecture:** The `dome.daily.today/v1` surface is three tiers — producer (`assets/extensions/dome.daily/processors/{today,action-state}.ts`), contract + view-model (`src/surface/today-view.ts`), and two paint adapters (`src/cli/commands/today.ts`, `src/http/today-html.ts`). Priority needs a tier-1 contract widen + tier-2 parse; brief and agenda are pure CLI paint (data already in the model); hero retirement is a tier-2 view-model change that both adapters consume. The producer already emits `priority` on every task row (it rides the `DailyTaskItem` spread), so no producer edit is required — the contract just stops stripping it.

**Tech Stack:** TypeScript on Bun, `bun:test`, zod (contract), picocolors (CLI paint via the presenter).

## Global Constraints

- `@dome/sdk` core has no LLM/MCP dependency; this work stays in `src/surface`, `src/cli`, `src/http` and touches no engine code.
- The producer constructs `ViewEffect` data against the **erased** `TodayPayload` type (no runtime zod in the bundle); the contract is `src/surface/today-view.ts`'s `todayPayloadSchema`.
- `parseTodayView` must stay **total** (never throw) for render resilience; the schema is the strict validator for the producer + agent/MCP consumers.
- The CLI row-width invariant: every rendered row's visible width ≤ `caps.width`. Any new gutter (priority marker, agenda time) is reserved out of the text budget.
- Presenter purity: rendering is a pure function of the injected `Caps`; never read `process.env`/`process.stdout` in paint code. Tests inject `Caps`.
- Test execution: gate on `bun run typecheck` + **scoped** test files (the full `bun test ./tests` is flaky under parallel load — see `dome-full-suite-contention`). Never use `Date.now()`/`new Date()` non-determinism in tests; pass fixed date strings.
- Priority levels (verbatim): `highest`, `high`, `medium`, `low`, `lowest`. Markers: `▲▲` highest, `▲` high, (blank) medium/none, `▽` low, `▽▽` lowest. ASCII fallback: `^^`, `^`, ``, `v`, `vv`.

---

### Task 1: Priority on the contract + parse

Add `priority` to the `dome.daily.today/v1` wire contract and the render-path enrich. No producer change — `DailyTaskItem` already carries `priority`, so it rides the existing `openTasks`/`followups` spread; the contract just stops dropping it.

**Files:**
- Modify: `src/surface/today-view.ts` (`taskRowWireSchema`, `TodayTaskRow`, `parseTaskRows`, `parseHero` task branch)
- Test: `tests/surface/today-view.test.ts`, `tests/surface/today-payload.test.ts`

**Interfaces:**
- Produces: `TodayTaskRow.priority: "highest" | "high" | "medium" | "low" | "lowest" | null` — consumed by Task 5 (marker paint). `parseTaskRows`/`parseHero` populate it null-safely (unknown string → `null`).

- [ ] **Step 1: Write the failing view-model parse test**

In `tests/surface/today-view.test.ts`, add:

```ts
test("parseTaskRows carries priority for all five literals + null/unknown", () => {
  const v = parseTodayView({
    date: "2026-06-23",
    openTasks: [
      { text: "a", path: "p", line: 1, dueDate: null, priority: "highest" },
      { text: "b", path: "p", line: 2, dueDate: null, priority: "low" },
      { text: "c", path: "p", line: 3, dueDate: null },
      { text: "d", path: "p", line: 4, dueDate: null, priority: "bogus" },
    ],
    followups: [], questions: [],
    counts: { openTasks: 4, followups: 0, questions: 0 },
    brief: null, calendar: null, hero: null,
  });
  expect(v.openTasks.map((t) => t.priority)).toEqual(["highest", "low", null, null]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/surface/today-view.test.ts -t "carries priority"`
Expected: FAIL — `priority` is `undefined`/absent on `TodayTaskRow`.

- [ ] **Step 3: Add `priority` to the wire schema + types + parsers**

In `src/surface/today-view.ts`:

Add to `TodayTaskRow` (after `entities?`):

```ts
  /** Obsidian task priority parsed by the producer; null when untagged. */
  readonly priority?: "highest" | "high" | "medium" | "low" | "lowest" | null;
```

Add to `taskRowWireSchema` (after `origin`):

```ts
  priority: z
    .enum(["highest", "high", "medium", "low", "lowest"])
    .nullable()
    .optional(),
```

Add a private helper near the other parsers:

```ts
const PRIORITY_LEVELS = ["highest", "high", "medium", "low", "lowest"] as const;
type ParsedPriority = (typeof PRIORITY_LEVELS)[number];

function parsePriority(raw: unknown): ParsedPriority | null {
  return typeof raw === "string" && (PRIORITY_LEVELS as readonly string[]).includes(raw)
    ? (raw as ParsedPriority)
    : null;
}
```

In `parseTaskRows`, compute and spread it (only when non-null, to keep objects clean):

```ts
    const priority = parsePriority(r.priority);
    return [{
      text,
      path: typeof r.path === "string" ? r.path : "",
      line: typeof r.line === "number" ? r.line : null,
      dueDate: typeof r.dueDate === "string" ? r.dueDate : null,
      ...(origin !== undefined ? { origin } : {}),
      ...(entities.length > 0 ? { entities } : {}),
      ...(priority !== null ? { priority } : {}),
    }];
```

In `parseHero`'s `kind === "task"` branch, add the same `...(priority !== null ? { priority } : {})` to the returned `item` (compute `const priority = parsePriority(item.priority);` first).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/surface/today-view.test.ts -t "carries priority"`
Expected: PASS.

- [ ] **Step 5: Write + run the contract (schema) test**

In `tests/surface/today-payload.test.ts`, add (match the file's existing import of `todayPayloadSchema`):

```ts
test("todayPayloadSchema validates priority and still strips extras", () => {
  const parsed = todayPayloadSchema.parse({
    date: "2026-06-23",
    counts: { openTasks: 1, followups: 0, questions: 0 },
    openTasks: [{ text: "a", path: "p", line: 1, dueDate: null, priority: "high", attention: { discount: 0.1 } }],
    followups: [], questions: [], brief: null, calendar: null, hero: null,
  });
  expect(parsed.openTasks[0]!.priority).toBe("high");
  expect((parsed.openTasks[0] as Record<string, unknown>).attention).toBeUndefined(); // extra stripped
});
```

Run: `bun test tests/surface/today-payload.test.ts -t "validates priority"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/surface/today-view.ts tests/surface/today-view.test.ts tests/surface/today-payload.test.ts
git commit -m "feat(today): carry task priority through the today/v1 contract + parse"
```

---

### Task 2: Retire the hero (view-model + both paints)

Stop hero-dedup in the view-model and remove `hero`/`heroUrgency` from `TodayViewModel`; both adapters drop their hero rendering. This is one coupled task because removing the view-model fields breaks both adapters' compilation — they must land together to stay green. The producer's `selectHero` and the wire `hero` field stay **dormant** (untouched).

**Files:**
- Modify: `src/surface/today-view.ts` (`buildTodayViewModel`, `TodayViewModel`)
- Modify: `src/cli/commands/today.ts` (`formatTodayResult` hero block + counts; delete `heroUrgencyStrings`)
- Modify: `src/http/today-html.ts` (`renderTodayHtml` destructure + hero pill; delete `renderHeroHtml`)
- Test: `tests/surface/today-view.test.ts`, `tests/cli/commands/today.test.ts`, `tests/http/today-html.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `TodayViewModel` no longer has `hero` or `heroUrgency`; `stillOpen` now contains **every** open task + followup (no item removed). Tasks 3–5 paint against this.

- [ ] **Step 1: Write the failing view-model test (no task vanishes)**

In `tests/surface/today-view.test.ts`, add:

```ts
test("buildTodayViewModel no longer exposes a hero; every open task lands in a section", () => {
  const vm = buildTodayViewModel(parseTodayView({
    date: "2026-06-23",
    openTasks: [
      { text: "overdue thing", path: "p", line: 1, dueDate: "2026-06-10" },
      { text: "someday thing", path: "p", line: 2, dueDate: null },
    ],
    followups: [], questions: [],
    counts: { openTasks: 2, followups: 0, questions: 0 },
    brief: null, calendar: null,
    // even when the payload still carries a hero, the view-model ignores it:
    hero: { kind: "task", item: { text: "overdue thing", path: "p", line: 1, dueDate: "2026-06-10" } },
  }));
  expect("hero" in vm).toBe(false);
  expect("heroUrgency" in vm).toBe(false);
  const sectioned = [...vm.stillOpen.overdue, ...vm.stillOpen.someday].map((t) => t.text);
  expect(sectioned).toEqual(["overdue thing", "someday thing"]); // the would-be hero is NOT deduped out
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/surface/today-view.test.ts -t "no longer exposes a hero"`
Expected: FAIL — `vm.hero` still present and `overdue thing` is deduped out.

- [ ] **Step 3: Remove hero from the view-model**

In `src/surface/today-view.ts`:

Delete `hero` and `heroUrgency` from the `TodayViewModel` type.

In `buildTodayViewModel`, delete the `heroIsTask`/`heroKey` lines and the dedup `continue`, and drop `hero`/`heroUrgency` from the returned object. The loop becomes:

```ts
  for (const t of [...openTasks, ...followups]) {
    const urgency = classifyUrgency(t.dueDate, date);
    if (urgency.kind === "overdue") sections.overdue.push(t);
    else if (urgency.kind === "due-today") sections.dueToday.push(t);
    else if (urgency.kind === "this-week") sections.thisWeek.push(t);
    else if (urgency.kind === "later") sections.later.push(t);
    else sections.someday.push(t);
  }
```

Keep destructuring `hero` out of `view` only if still referenced; remove `hero` from the destructure since it's now unused. (`TodayHeroItem`, `parseHero`, and the wire `hero` field stay — they are dormant.)

- [ ] **Step 4: Update the CLI paint (remove hero block + fix counts)**

In `src/cli/commands/today.ts`:

Delete the `heroUrgencyStrings` function entirely.

In `formatTodayResult`: remove `hero`, `heroUrgency` from the `buildTodayViewModel(...)` destructure. Delete the entire `// Hero action line` block (`if (hero !== null) { ... }`). Fix the two count expressions:

```ts
  // before: stillOpen.overdue.length + (heroUrgency?.kind === "overdue" ? 1 : 0)
  const overdueCount = stillOpen.overdue.length;
```

and in the overflow section:

```ts
  // before: const trueTotal = (counts.openTasks + counts.followups) - (heroIsTask ? 1 : 0);
  const trueTotal = counts.openTasks + counts.followups;
```

Delete the now-unused `heroIsTask` line.

- [ ] **Step 5: Update the HTTP paint (remove hero pill)**

In `src/http/today-html.ts`:

Remove `hero`, `heroUrgency` from the `buildTodayViewModel(...)` destructure. Delete `const heroHtml = ...` and its use in `bodyContent` (replace `${heroHtml}${bandHtml}` with `${bandHtml}`). Delete the `renderHeroHtml` function and the `.hero`, `.hero-arrow`, `.hero-text`, `.hero-urgency*` CSS rules. Fix `trueOpenCount`:

```ts
  // before: counts.openTasks + counts.followups - (heroIsTask ? 1 : 0)
  const trueOpenCount = counts.openTasks + counts.followups;
```

Delete the now-unused `heroIsTask` line. Remove the `TodayHeroItem`/`TaskUrgency` imports if no longer referenced.

- [ ] **Step 6: Write the failing CLI + HTTP "no hero" tests**

In `tests/cli/commands/today.test.ts`, add (uses the existing `formatTodayResult` import + an explicit Caps):

```ts
test("formatTodayResult renders no hero pointer; the would-be hero appears in OVERDUE", () => {
  const caps = { color: false, unicode: true, width: 80 };
  const out = formatTodayResult({
    date: "2026-06-23",
    counts: { openTasks: 1, followups: 0, questions: 0 },
    openTasks: [{ text: "overdue thing", path: "p", line: 1, dueDate: "2026-06-10" }],
    followups: [], questions: [], brief: null, calendar: null,
    hero: { kind: "task", item: { text: "overdue thing", path: "p", line: 1, dueDate: "2026-06-10" } },
  }, caps, "/tmp/work");
  expect(out).not.toContain("→ overdue thing");
  expect(out).toContain("OVERDUE");
  expect(out).toContain("overdue thing");
});
```

In `tests/http/today-html.test.ts`, add:

```ts
test("renderTodayHtml emits no hero pill", () => {
  const html = renderTodayHtml({
    date: "2026-06-23",
    counts: { openTasks: 1, followups: 0, questions: 0 },
    openTasks: [{ text: "overdue thing", path: "p", line: 1, dueDate: "2026-06-10" }],
    followups: [], questions: [], brief: null, calendar: null,
    hero: { kind: "task", item: { text: "overdue thing", path: "p", line: 1, dueDate: "2026-06-10" } },
  }, { refreshSeconds: 5 });
  expect(html).not.toContain('class="hero"');
  expect(html).toContain("overdue thing");
});
```

- [ ] **Step 7: Run the three test files**

Run: `bun test tests/surface/today-view.test.ts tests/cli/commands/today.test.ts tests/http/today-html.test.ts`
Expected: PASS (including the three new tests). Investigate any prior hero-asserting test that now fails — update it to the no-hero reality (e.g. an old "renders hero pointer" assertion should be deleted or inverted).

- [ ] **Step 8: Commit**

```bash
git add src/surface/today-view.ts src/cli/commands/today.ts src/http/today-html.ts tests/surface/today-view.test.ts tests/cli/commands/today.test.ts tests/http/today-html.test.ts
git commit -m "refactor(today): retire the hero from the view-model + both paints (producer machinery parked)"
```

---

### Task 3: Brief by default (CLI paint)

Show the grounded morning brief under the verdict header by default; strip `[[wikilinks]]`; keep the source path under `--verbose` only.

**Files:**
- Modify: `src/cli/commands/today.ts` (`formatTodayResult`)
- Test: `tests/cli/commands/today.test.ts`

**Interfaces:**
- Consumes: `TodayViewModel.brief: { text, sourceRef: { path } } | null` (unchanged).

- [ ] **Step 1: Write the failing test**

In `tests/cli/commands/today.test.ts`, add:

```ts
test("brief shown by default with wikilinks stripped; source path only under --verbose", () => {
  const caps = { color: false, unicode: true, width: 80 };
  const data = {
    date: "2026-06-23",
    counts: { openTasks: 0, followups: 0, questions: 0 },
    openTasks: [], followups: [], questions: [], calendar: null, hero: null,
    brief: { text: "Focus on [[wiki/rh-chain|RH Chain]] today.", sourceRef: { path: "wiki/dailies/2026-06-23.md" } },
  };
  const plain = formatTodayResult(data, caps, "/tmp/work");
  expect(plain).toContain("Focus on RH Chain today."); // wikilink stripped to label
  expect(plain).not.toContain("[[");
  expect(plain).not.toContain("wiki/dailies/2026-06-23.md"); // path hidden by default
  expect(plain).not.toContain("--verbose for full brief");

  const verbose = formatTodayResult(data, caps, "/tmp/work", { verbose: true });
  expect(verbose).toContain("wiki/dailies/2026-06-23.md"); // path shown under --verbose
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/commands/today.test.ts -t "brief shown by default"`
Expected: FAIL — brief currently hidden behind `--verbose`; default shows the nudge instead.

- [ ] **Step 3: Render the brief at the top, remove the bottom block**

In `src/cli/commands/today.ts`, `formatTodayResult`:

Ensure `stripWikilinks` is imported from `../presenter` (it already exports it — see the test import). Right after the header push (`headline(...)`, `""`), insert the brief:

```ts
  if (brief !== null) {
    for (const line of wrap(stripWikilinks(brief.text), Math.max(8, caps.width - 2))) {
      lines.push(`  ${line}`);
    }
    if (opts.verbose === true && brief.sourceRef.path.length > 0) {
      lines.push(`  ${paint(brief.sourceRef.path, "muted", caps)}`);
    }
    lines.push("");
  }
```

Import `wrap` from `../presenter` (it's exported via the presenter index/width module). Delete the entire trailing `// Brief prose: hidden by default` block at the end of the function (both the `--verbose` and the "`--verbose for full brief`" nudge branches).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/cli/commands/today.test.ts -t "brief shown by default"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/today.ts tests/cli/commands/today.test.ts
git commit -m "feat(today): show the morning brief by default (wikilinks stripped; path under --verbose)"
```

---

### Task 4: Calendar agenda (CLI paint)

Replace the one-line `· N events` summary with a time-gutter agenda rendered from `calendar.events`.

**Files:**
- Modify: `src/cli/commands/today.ts` (`formatTodayResult`)
- Test: `tests/cli/commands/today.test.ts`

**Interfaces:**
- Consumes: `TodayViewModel.calendar: { events: ReadonlyArray<{ time, title, meta }>, sourceRef } | null`.

- [ ] **Step 1: Write the failing test**

In `tests/cli/commands/today.test.ts`, add:

```ts
test("calendar renders a time-gutter agenda with meta; caps at 5 with overflow", () => {
  const caps = { color: false, unicode: true, width: 80 };
  const events = Array.from({ length: 7 }, (_, i) => ({
    time: `0${i}:00`, title: `Event ${i}`, meta: i === 0 ? "Cody, Grayson" : "",
  }));
  const out = formatTodayResult({
    date: "2026-06-23",
    counts: { openTasks: 0, followups: 0, questions: 0 },
    openTasks: [], followups: [], questions: [], brief: null, hero: null,
    calendar: { events, sourceRef: { path: "sources/calendar/2026-06-23.md" } },
  }, caps, "/tmp/work");
  expect(out).toContain("agenda");
  expect(out).toContain("00:00  Event 0");
  expect(out).toContain("Cody, Grayson");       // meta rendered
  expect(out).toContain("04:00  Event 4");        // 5th event shown
  expect(out).not.toContain("05:00  Event 5");    // capped
  expect(out).toContain("+2 more");               // overflow
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/commands/today.test.ts -t "time-gutter agenda"`
Expected: FAIL — current code prints `today <date> · N events`, no per-event rows.

- [ ] **Step 3: Replace the calendar summary with the agenda block**

In `src/cli/commands/today.ts`, `formatTodayResult`, replace the existing calendar block (the `if (calendar !== null && calendar.events.length > 0) { ... }` that pushes the one-line summary) with:

```ts
  if (calendar !== null && calendar.events.length > 0) {
    lines.push(`  ${paint("agenda", "muted", caps)}  ${paint(date, "plain", caps)}`);
    const AGENDA_CAP = 5;
    const shown = opts.verbose === true ? calendar.events.length : Math.min(AGENDA_CAP, calendar.events.length);
    const timeWidth = calendar.events.slice(0, shown).reduce(
      (m, e) => Math.max(m, visibleWidth(e.time)), 0,
    );
    for (const ev of calendar.events.slice(0, shown)) {
      const time = paint(pad(ev.time === "" ? "—" : ev.time, timeWidth), "muted", caps);
      const metaTail = ev.meta.length > 0 ? `   ${paint(ev.meta, "muted", caps)}` : "";
      const titleBudget = Math.max(8, caps.width - 4 - timeWidth - 3 - visibleWidth(ev.meta) - 3);
      const title = shortenLabel(stripEmphasis(ev.title), titleBudget, caps.unicode);
      lines.push(`    ${time}  ${title}${metaTail}`);
    }
    const more = calendar.events.length - shown;
    if (more > 0) lines.push(`    ${paint(`+${more} more`, "muted", caps)}`);
    lines.push("");
  }
```

Import `pad` from `../presenter` (exported from the width module). `visibleWidth`, `shortenLabel`, `stripEmphasis`, `paint` are already imported.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/cli/commands/today.test.ts -t "time-gutter agenda"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/today.ts tests/cli/commands/today.test.ts
git commit -m "feat(today): render the calendar agenda (time gutter + meta) instead of a count"
```

---

### Task 5: Priority markers — all five (shared helper + both paints)

Paint a fixed-width priority gutter between the status glyph and the task text in both adapters, using a shared char mapping so the two surfaces can't drift on what a level looks like.

**Files:**
- Modify: `src/surface/today-view.ts` (export `priorityMarkerChars`)
- Modify: `src/cli/commands/today.ts` (`renderRow` in `formatTodayResult`)
- Modify: `src/http/today-html.ts` (`renderStillOpenHtml`'s `renderItem` + CSS)
- Test: `tests/surface/today-view.test.ts`, `tests/cli/commands/today.test.ts`, `tests/http/today-html.test.ts`

**Interfaces:**
- Consumes: `TodayTaskRow.priority` (Task 1).
- Produces: `priorityMarkerChars(priority, unicode): string` — `"▲▲"`/`"▲"`/`""`/`"▽"`/`"▽▽"` (ASCII `"^^"`/`"^"`/`""`/`"v"`/`"vv"`). Consumed by both adapters.

- [ ] **Step 1: Write the failing helper test**

In `tests/surface/today-view.test.ts`, add (extend the import to include `priorityMarkerChars`):

```ts
test("priorityMarkerChars maps all five levels + null", () => {
  expect(priorityMarkerChars("highest", true)).toBe("▲▲");
  expect(priorityMarkerChars("high", true)).toBe("▲");
  expect(priorityMarkerChars("medium", true)).toBe("");
  expect(priorityMarkerChars("low", true)).toBe("▽");
  expect(priorityMarkerChars("lowest", true)).toBe("▽▽");
  expect(priorityMarkerChars(null, true)).toBe("");
  expect(priorityMarkerChars("highest", false)).toBe("^^");
  expect(priorityMarkerChars("lowest", false)).toBe("vv");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/surface/today-view.test.ts -t "priorityMarkerChars"`
Expected: FAIL — function not exported.

- [ ] **Step 3: Add the shared helper**

In `src/surface/today-view.ts`, add and export:

```ts
/** Plain (uncolored) priority marker glyphs; the gutter width is 2 cols. */
export function priorityMarkerChars(
  priority: TodayTaskRow["priority"] | undefined,
  unicode: boolean,
): string {
  switch (priority) {
    case "highest": return unicode ? "▲▲" : "^^";
    case "high":    return unicode ? "▲"  : "^";
    case "low":     return unicode ? "▽"  : "v";
    case "lowest":  return unicode ? "▽▽" : "vv";
    default:        return ""; // medium / null / undefined → no mark
  }
}
```

- [ ] **Step 4: Run helper test to verify it passes**

Run: `bun test tests/surface/today-view.test.ts -t "priorityMarkerChars"`
Expected: PASS.

- [ ] **Step 5: Write the failing CLI marker test**

In `tests/cli/commands/today.test.ts`, add:

```ts
test("priority markers render in a reserved gutter and keep rows within width", () => {
  const caps = { color: false, unicode: true, width: 80 };
  const out = formatTodayResult({
    date: "2026-06-23",
    counts: { openTasks: 2, followups: 0, questions: 0 },
    openTasks: [
      { text: "ship it", path: "p", line: 1, dueDate: "2026-06-10", priority: "highest" },
      { text: "later maybe", path: "p", line: 2, dueDate: "2026-06-10" },
    ],
    followups: [], questions: [], brief: null, calendar: null, hero: null,
  }, caps, "/tmp/work");
  expect(out).toContain("▲▲ ship it");
  // unmarked row keeps the gutter so text columns align (3-col gutter after glyph):
  const line = out.split("\n").find((l) => l.includes("later maybe"))!;
  expect(line).toMatch(/✗ {3}later maybe/); // glyph + space + 3-col blank gutter
  for (const l of out.split("\n")) expect(visibleWidth(l)).toBeLessThanOrEqual(80);
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `bun test tests/cli/commands/today.test.ts -t "priority markers render"`
Expected: FAIL — no marker gutter today.

- [ ] **Step 7: Paint the marker in the CLI `renderRow`**

In `src/cli/commands/today.ts`, import `priorityMarkerChars` from `../../surface/today-view`. Inside `formatTodayResult`'s `renderRow`, after computing `g` (the painted glyph) and before assembling the final line, build a fixed 3-col gutter (widest marker `▲▲` = 2 cols + 1 space) and reserve it from the text budget:

```ts
      const MARKER_GUTTER = 3; // "▲▲ " — widest marker + trailing space
      const markerRaw = priorityMarkerChars(t.priority, caps.unicode);
      const markerTone: Tone =
        t.priority === "highest" || t.priority === "high" ? "err" : "muted";
      const marker = markerRaw.length > 0
        ? paint(pad(markerRaw, MARKER_GUTTER - 1), markerTone, caps) + " "
        : " ".repeat(MARKER_GUTTER);
```

Reduce the label budget by `MARKER_GUTTER` (add it alongside `indent` in `effectiveWidth`):

```ts
      const effectiveWidth = taskWidth - indent - MARKER_GUTTER;
```

And put the marker between glyph and indent/label in the final push:

```ts
      lines.push(`  ${g} ${marker}${indentStr}${label}${inlineTail}${originTail}`);
```

Ensure `pad` is imported from `../presenter` (added in Task 4) and `Tone` is imported (it already is).

- [ ] **Step 8: Run CLI test to verify it passes**

Run: `bun test tests/cli/commands/today.test.ts -t "priority markers render"`
Expected: PASS.

- [ ] **Step 9: Write the failing HTTP marker test + paint it**

In `tests/http/today-html.test.ts`, add:

```ts
test("renderTodayHtml paints a priority marker span on high-priority rows", () => {
  const html = renderTodayHtml({
    date: "2026-06-23",
    counts: { openTasks: 1, followups: 0, questions: 0 },
    openTasks: [{ text: "ship it", path: "p", line: 1, dueDate: "2026-06-10", priority: "highest" }],
    followups: [], questions: [], brief: null, calendar: null, hero: null,
  }, { refreshSeconds: 5 });
  expect(html).toContain("prio");        // marker class present
  expect(html).toContain("▲▲");
});
```

In `src/http/today-html.ts`, import `priorityMarkerChars` from `../surface/today-view`. In `renderStillOpenHtml`'s `renderItem`, prepend a marker span when present:

```ts
    const markerChars = priorityMarkerChars(t.priority, true);
    const markerHtml = markerChars.length > 0
      ? `<span class="prio ${t.priority === "highest" || t.priority === "high" ? "prio-high" : "prio-low"}">${markerChars}</span> `
      : "";
```

and render it before `${esc(t.text)}` inside `.open-text`:

```ts
          <div class="open-text">${markerHtml}${esc(t.text)}</div>
```

Add CSS near the other `.open-*` rules:

```css
    .prio { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; }
    .prio-high { color: #FF593C; }
    .prio-low { color: rgba(255,255,255,0.4); }
```

- [ ] **Step 10: Run HTTP test to verify it passes**

Run: `bun test tests/http/today-html.test.ts -t "priority marker span"`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/surface/today-view.ts src/cli/commands/today.ts src/http/today-html.ts tests/surface/today-view.test.ts tests/cli/commands/today.test.ts tests/http/today-html.test.ts
git commit -m "feat(today): paint all-five priority markers in both adapters via a shared mapping"
```

---

### Task 6: Full verification

Typecheck the three project configs and run the touched test files in scope (avoid the flaky full-suite parallel run).

**Files:** none (verification only).

- [ ] **Step 1: Typecheck**

Run: `bun run typecheck`
Expected: PASS (no errors). Common catch: a dangling `hero`/`heroUrgency`/`TodayHeroItem`/`renderHeroHtml` reference, or an unused import — fix at the named site.

- [ ] **Step 2: Run the touched test files**

Run: `bun test tests/surface/today-view.test.ts tests/surface/today-payload.test.ts tests/cli/commands/today.test.ts tests/http/today-html.test.ts tests/extensions/daily-today-view.test.ts`
Expected: PASS. If `tests/extensions/daily-today-view.test.ts` asserts a hero shape, update it to the no-hero reality.

- [ ] **Step 3: Run the CLI surface scenario**

Run: `bun test tests/harness/scenarios/cli-surface/today-task-view.scenario.test.ts`
Expected: PASS. Update any golden/snapshot that encoded the hero line or the old calendar summary to the new layout.

- [ ] **Step 4: Final commit (if any fixups)**

```bash
git add -A
git commit -m "test(today): align today/daily tests with enriched view (hero retired, brief/agenda/priority)"
```

---

## Self-Review

**Spec coverage:**
- Retire hero (tier 2 + both paints, producer parked, counts fixed) → Task 2. ✓
- Brief by default (wikilinks stripped, path under --verbose) → Task 3. ✓
- Calendar agenda (time gutter, meta, cap+overflow) → Task 4. ✓
- Priority markers all five (tier 1 + 2 + 3, shared mapping, reserved gutter) → Tasks 1 + 5. ✓
- Width invariant / no-vanish / count exactness / parse resilience → Tasks 1, 2, 5 tests. ✓
- `--json` unchanged (priority added, hero still in payload) → covered by Task 1 contract test + no change to the json branch. ✓

**Type consistency:** `priorityMarkerChars` (Task 5) consumes `TodayTaskRow["priority"]` (Task 1); both adapters import it from `src/surface/today-view.ts`. `TodayViewModel` loses `hero`/`heroUrgency` in Task 2 and no later task references them. `pad` import added in Task 4 and reused in Task 5.

**Placeholder scan:** none — every code/test step carries concrete content and exact run commands.
