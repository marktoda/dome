# Compiled-Blocks Daily Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Invert the daily-note pipeline: deterministic blocks (questions/agenda/integrated/sources) get a deterministic owner (`dome.daily.compose-blocks`) that re-renders when inputs change; the brief slims to three narrative blocks gated by a deterministic compose-record.

**Architecture:** One new deterministic garden processor owns four `dome.daily:*` blocks in today's daily, triggered by a new `questions.changed` store signal (dispatched on the answers.ts precedent, NOT through compileRange), source-file signals, and a 05:25 cron. A new `questions.read` capability exposes open questions via `ctx.operational`, mirroring `outbox.read`/`quarantine.read`/`run.read` exactly. The brief loses its deterministic blocks and its projection dead-reads; its staleness gate becomes a compose-record block with per-input content hashes.

**Tech Stack:** Bun + TypeScript, bun:test, zod schemas in `src/core/processor.ts`, the generated-block primitive in `src/core/generated-block.ts`.

**Design doc:** `docs/cohesive/brainstorms/2026-07-01-compiled-blocks-daily-design.md` (read it first).

## Global Constraints

- Repo discipline: spec edit first, then implementation, then tests. Specs are Task 1.
- Processor purity (`tests/integration/processor-purity.test.ts`): processors import no `bun`, `node:fs`, sqlite, git; they read `ctx.snapshot` and return Effects. Use `ctx.now()`, never `Date.now()` (`tests/integration/processor-clock.test.ts`).
- Every marker string comes from `src/core/generated-block.ts` (`generatedBlockMarkers` etc.) — the splice-guard test rejects hand-rolled markers.
- Import direction between bundles: dome.agent → dome.daily only (one legacy exception exists in `settle-stale-answer.ts`; do not add more).
- Typecheck gate: `bun run typecheck` (three tsc passes). Test scoping: `bun test <path>` — do NOT run the full suite until the final task (parallel-load flakiness); scope per task.
- Commit after every task with a conventional message; end commit messages with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Worktree: `/Users/mark.toda/dev/dome/.claude/worktrees/compiled-daily+build` (branch `compiled-daily/build`). All paths below are relative to this root.

---

### Task 1: Spec edits

**Files:**
- Modify: `docs/wiki/specs/daily-surface.md`
- Modify: `docs/wiki/specs/autonomous-agents.md`
- Modify: `docs/wiki/specs/processors.md`
- Modify: `docs/wiki/specs/capabilities.md`

**Interfaces:** Produces the normative contract later tasks implement. No code.

- [ ] **Step 1: `daily-surface.md`** — apply these edits:
  - Choreography table: add a row `| 05:25 | dome.daily.compose-blocks | dome.daily | Deterministic block compile: questions / agenda / integrated / sources rendered from current inputs; also fires on questions.changed + source-file + sweep-ledger signals all day. |` Update the 05:30 brief row: the brief now composes only the narrative blocks (today, yesterday, meetings prep prose) gated by the compose-record.
  - §"The section contract" table: `Start Here` row's hosted blocks become `dome.agent.brief:today`, `dome.agent.brief:yesterday`, `dome.daily:questions`, `dome.daily:integrated`, `dome.daily:sources`, `dome.agent.brief:compose-record`; `Meetings` row hosts `dome.daily:agenda` (top) + `dome.agent.brief:meetings` (prep prose below).
  - §"Block ownership" table: mark `dome.agent.brief:questions`, `dome.agent.brief:integrated`, `dome.agent.brief:sources` as **retired-legacy: recognized, never written** (same treatment as `dome.daily:start-context`, including the today-only migration note: compose-blocks removes them from today's daily in the same patch that writes the replacements; historical dailies untouched). Add rows for the four new `dome.daily:*` blocks (writer `dome.daily.compose-blocks`, deterministic, timing "05:25 cron + questions.changed / source / ledger signals") and `dome.agent.brief:compose-record` (writer `dome.agent.brief`, deterministic record line, written on every successful compose; the failure-stub path never writes it).
  - §"Wake-tick choreography": replace the sources-seen-gate paragraph: re-compose is now gated by the compose-record (per-input content hashes: calendar, slack, today's sweep-ledger section, yesterday's daily; all-match → zero-model no-op; cap 3 model composes/day → info diagnostic beyond).
  - §"The degradation ladder": update the no-model rung (deterministic package now includes agenda + questions + integrated + sources), replace the "source lands after brief" rung's gate description with the compose-record, and add two rungs: `questions.read declared but ctx.operational.questions absent → warning diagnostic dome.daily.questions-view-missing, block omitted` and `compose-blocks run fails → normal deterministic-run failure path (ledger, quarantine after 3)`. State the sources-block rule: entries only for source kinds whose day-file exists; block omitted entirely when none (never a perpetual `calendar — · slack —`).
- [ ] **Step 2: `autonomous-agents.md`** — in the `dome.agent.brief` section: charter slims to three model blocks (today / yesterday / meetings-prep); the questions/integrated/sources blocks move to `dome.daily.compose-blocks`; document the compose-record block (grammar: one italic line `_Composed <n>× HH:MM · calendar@<hash8|—> · slack@<hash8|—> · ledger@<hash8|—> · yesterday@<hash8|—>_`), the fingerprint gate, the 3/day cap, and that the failure-stub "composed already today" check now reads the compose-record. Note the meetings block is prep prose beneath the deterministic `dome.daily:agenda` block and must not restate the agenda list.
- [ ] **Step 3: `processors.md`** — in §"Triggers and signals": add `questions.changed` to the signal list with this contract: *store-change signal; NOT synthesized by compileRange (signals there are tree-diff-derived); dispatched on its own channel (`src/engine/operational/questions-changed.ts`) after any tick that changed the open-question set (new/refreshed-open insert, stale-question resolution, durable answer) and after resolve; subscribers are ordinary garden processors declaring `{kind: signal, name: questions.changed}`; the dispatch synthesizes `TriggerMatch`es directly (no path filtering; `SignalEvent.path` is `""`).*
- [ ] **Step 4: `capabilities.md`** — add `questions.read` to the operational read tier alongside `outbox.read`/`quarantine.read`/`run.read`: grants read access to open/resolved question rows via `ctx.operational.questions(filter?)`; enforced at view-construction (declared ∩ granted), not by the broker (no Effect).
- [ ] **Step 5: Commit** — `git add docs/wiki/specs && git commit -m "docs(specs): compiled-blocks daily — compose-blocks owner, questions.changed signal, questions.read capability, compose-record gate"`

---

### Task 2: Core vocabulary — `questions.changed` signal + `questions.read` capability

**Files:**
- Modify: `src/core/processor.ts` (Signal union ~L153; capability types ~L276-324; `SignalSchema` ~L726; capability zod ~L860-928)
- Test: `tests/core/processor.test.ts`, `tests/processors/triggers.test.ts`

**Interfaces:**
- Produces: `Signal` union includes `"questions.changed"`; `QuestionsReadCapability = { readonly kind: "questions.read" }` in the `Capability` union; `QuestionsReadCapabilitySchema` registered in `CapabilitySchema`.

- [ ] **Step 1: Write failing tests.** In `tests/core/processor.test.ts`: find the `SignalSchema` assertions and add `expect(SignalSchema.parse("questions.changed")).toBe("questions.changed");` find the describe titled `CapabilitySchema (discriminated union, 16 kinds)`, rename to `17 kinds`, add `expect(CapabilitySchema.parse({ kind: "questions.read" }).kind).toBe("questions.read");` In `tests/processors/triggers.test.ts` add:

```ts
test("questions.changed signal trigger matches a questions.changed event", () => {
  const trigger = { kind: "signal", name: "questions.changed" } as const;
  const matches = matchTriggers(
    [trigger],
    [{ signal: "questions.changed", path: "" }],
  );
  expect(matches).toHaveLength(1);
  expect(matches[0]?.matchedSignals).toEqual([
    { signal: "questions.changed", path: "" },
  ]);
});
```

- [ ] **Step 2: Run to verify failure.** `bun test tests/core/processor.test.ts tests/processors/triggers.test.ts` — expect zod parse failures / type errors.
- [ ] **Step 3: Implement.** In `src/core/processor.ts`: add `| "questions.changed"` to the `Signal` union (L153-161) and to the `SignalSchema` z.enum (L726-735). Add near L284 (beside `QuarantineReadCapability`):

```ts
/** Read open/resolved question rows via `ctx.operational.questions`. */
export type QuestionsReadCapability = {
  readonly kind: "questions.read";
};
```

Add `| QuestionsReadCapability` to the `Capability` union (~L308-324), a `QuestionsReadCapabilitySchema = z.object({ kind: z.literal("questions.read") }).strict()` beside `QuarantineReadCapabilitySchema` (~L874), register it in the `CapabilitySchema` discriminated union (~L911-928), and extend the doc-comment capability list (~L206-229) with `questions.read — read question rows via ctx.operational`.
- [ ] **Step 4: Run tests + the type↔schema fence.** `bun test tests/core/processor.test.ts tests/processors/triggers.test.ts tests/types 2>/dev/null; bun run typecheck` — all pass (the lockstep fence at `tests/types/schema-type-lockstep.ts` compiles under typecheck; fix any reported mismatch there by adding the new members).
- [ ] **Step 5: Commit** — `git commit -am "feat(core): questions.changed signal kind + questions.read capability"`

---

### Task 3: `ctx.operational.questions` — view, builder, per-capability gate, config grant

**Files:**
- Modify: `src/core/processor.ts` (`OperationalQueryView` L566-579)
- Modify: `src/engine/operational/operational-query-view.ts` (`buildOperationalQueryView` L30-63)
- Modify: `src/engine/host/vault-runtime.ts` (~L568 builder call site)
- Modify: `src/processors/runtime.ts` (`operationalContextField` L1220-1275 + `effective*` helpers L1277-1346)
- Modify: `src/cli/default-vault-config.ts` (~L118-125 dome.daily grants) and the vault-config grant parser (grep for how `"question.ask": true` in that file becomes a `Capability` — extend the same mapping with `"questions.read": true → { kind: "questions.read" }`)
- Test: `tests/engine/operational-query-view.test.ts` (create if absent — check for an existing test file for this module first), plus the runtime gating test (grep `operationalContextField` under `tests/` and extend where it is covered; if uncovered, add cases to the file that tests recovery-processor context wiring, e.g. `tests/engine/operational-work.test.ts`)

**Interfaces:**
- Consumes: `queryQuestionRecords(db, filter?, onSkip?)` from `src/projections/questions.ts` (L282-314) returning `QuestionRecord = { id, effect, processorId, runId, adoptedCommit, askedAt, answeredAt, answer }`.
- Produces: `OperationalQueryView.questions: (filter?: { readonly resolved?: boolean }) => ReadonlyArray<QuestionRecord>` — gated so it returns rows only when `questions.read` is declared ∩ granted; `ctx.operational` present iff ANY of the four read caps is effective.

- [ ] **Step 1: Failing test.** Add a test asserting: (a) `buildOperationalQueryView({...}).questions({ resolved: false })` returns seeded open questions; (b) in the runtime gate, a processor declaring+granted `{kind:"questions.read"}` sees `ctx.operational.questions(...)` return rows, a processor without it gets `[]` from the accessor (and if it declares NO operational read cap at all, `ctx.operational` is absent). Model construction on the existing operational-work tests (mkdtemp + real sqlite stores; see `tests/engine/operational-work.test.ts` for store setup and `insertQuestion` from `src/projections/questions.ts` for seeding).
- [ ] **Step 2: Run to verify failure.** Scoped `bun test` on the files you touched.
- [ ] **Step 3: Implement.**
  - `src/core/processor.ts`: add to `OperationalQueryView`:

```ts
  readonly questions: (filter?: {
    readonly resolved?: boolean;
  }) => ReadonlyArray<QuestionRecord>;
```

  Import/move the `QuestionRecord` type as needed — NOTE: `QuestionRecord` currently lives in `src/projections/questions.ts` (L43-52); `src/core/processor.ts` must not import from projections (import-direction fence). Define the row type in `src/core/processor.ts` (e.g. `OperationalQuestionRow` mirroring QuestionRecord's fields, reusing the existing `ProjectionQuestion`-adjacent types at L507-514 if they already fit) and have the builder adapt. Check `tests/integration/engine-import-direction.test.ts` for the allowed edges before choosing.
  - `src/engine/operational/operational-query-view.ts`: `buildOperationalQueryView` gains a `projection: ProjectionDb` opt (or narrower: `queryQuestions: (filter?) => ReadonlyArray<...>` closure — prefer the closure to keep the builder decoupled); wire the accessor.
  - `src/engine/host/vault-runtime.ts` ~L568: pass the projection-backed closure (the runtime owns the projection db handle; grep `openProjectionDb`/`projection` in that file).
  - `src/processors/runtime.ts` `operationalContextField` (L1220-1275): add `const canReadQuestions = effectiveQuestionsRead(frame.declared, frame.granted);` include it in the L1237 none-effective short-circuit, and add the wrapped accessor: `questions: (filter) => (canReadQuestions ? operational.questions(filter) : [])`. Add `effectiveQuestionsRead(declared, granted): boolean` beside `effectiveQuarantineRead` (L1306-1314) — same declared∩granted shape.
  - `src/cli/default-vault-config.ts` L118-125: add `"questions.read": true` to the dome.daily extension grants; extend the grant-key mapping the same way `question.ask: true` maps.
- [ ] **Step 4: Run tests.** Scoped tests + `bun run typecheck` pass.
- [ ] **Step 5: Commit** — `git commit -am "feat(engine): questions accessor on ctx.operational gated by questions.read"`

---

### Task 4: Signal emission + the `questions.changed` dispatcher

**Files:**
- Modify: `src/projections/questions.ts` (`insertQuestion` L207-227; `resolveStaleQuestions` L421-443 already returns a count — no change needed there)
- Create: `src/engine/operational/questions-changed.ts`
- Modify: `src/engine/core/apply-effect.ts` (~L772-778 `case "question"` — only if the sink signature must change; prefer wrapping at the sink construction site instead)
- Modify: `src/engine/host/compiler-host.ts` (garden-phase call sites ~L553 and ~L1134 — dispatch after garden phase when the tick changed questions)
- Modify: `src/engine/host/question-answering.ts` (after `answerQuestionDurably` → answer handlers, dispatch subscribers)
- Modify: `src/engine/operational/question-auto-resolution.ts` (after any `result.kind === "answered"`, mark changed; the host tick that ran auto-resolution dispatches)
- Test: `tests/engine/questions-changed.test.ts` (create), plus extend `tests/cli/commands/resolve.test.ts` only if the resolve path signature changes (avoid if possible)

**Interfaces:**
- Consumes: `dispatchGardenRun(deps: GardenRunDeps, run: GardenRun, diagnostics)` from `src/engine/garden/garden-run.ts` (L107-111); `answerHandlerCandidates` pattern from `src/engine/operational/answers.ts` (L190-236).
- Produces:

```ts
// src/engine/operational/questions-changed.ts
export type QuestionsChangedOptions = GardenRunDeps & {
  readonly registry: ProcessorRegistry;
};
/** Dispatch every garden processor subscribed to {kind:"signal", name:"questions.changed"}.
 *  Synthesizes TriggerMatches directly (no compileRange, no path filter). */
export async function runQuestionsChangedSubscribers(
  opts: QuestionsChangedOptions,
): Promise<{ readonly dispatched: number; readonly diagnostics: ReadonlyArray<DiagnosticEffect> }>;
```

Also: `insertQuestion` return type changes `void → InsertQuestionResult`:

```ts
export type InsertQuestionResult = "inserted" | "refreshed" | "skipped-answered";
```

- [ ] **Step 1: Failing tests.** `tests/engine/questions-changed.test.ts`:
  - `insertQuestion` returns `"inserted"` for a fresh key, `"refreshed"` for a re-emit on an unanswered row, `"skipped-answered"` after the row is answered (seed with `insertQuestion` + `answerQuestion`; sqlite in mkdtemp, per repo pattern).
  - `runQuestionsChangedSubscribers` with a registry containing one fake garden processor whose trigger is `{kind:"signal", name:"questions.changed"}` dispatches exactly that processor with envelope `{ kind: "garden", matchedTriggers: [{ trigger, matchedSignals: [{ signal: "questions.changed", path: "" }] }] }`, and dispatches nothing for a registry with no subscribers. Build `GardenRunDeps` the way `tests/` construct them for answers-flow tests (grep `runAnswerHandlers` under tests/ and copy its deps fixture; if none exists, model on how `tests/harness` builds engine deps — keep the unit test at the module level with minimal fake deps: fake registry + recording `dispatchGardenRun` is acceptable via dependency injection ONLY if the module takes it; otherwise use real sqlite-backed deps like the answers tests do).
- [ ] **Step 2: Verify failure.** `bun test tests/engine/questions-changed.test.ts`
- [ ] **Step 3: Implement.**
  - `insertQuestion` (L207-227): use the prepared statement's run result / `db.changes` to discriminate: no conflict → inserted; conflict+unanswered → refreshed (the UPDATE fires, changes=1); conflict+answered → skipped (changes=0). Bun sqlite: `Statement.run()` returns `{ changes, lastInsertRowid }` — check the repo's row-helper conventions in `src/sqlite/` and follow them. Update the one sink implementation that calls it to propagate the result upward (grep `insertQuestion(` for call sites; the sink lives where `recordQuestion` is constructed — follow `opts.sinks.recordQuestion` from `src/engine/core/apply-effect.ts:772` to its construction).
  - New module `src/engine/operational/questions-changed.ts` mirroring `answers.ts` structure: candidates = `registry.byPhase("garden")` filtered to processors having a `SignalTrigger` with `name === "questions.changed"`; for each, `dispatchGardenRun(opts, { processor, phase: "garden", envelope, matches, disabledDiagnostic: {...} }, diagnostics)` with the envelope above (copy the `disabledDiagnostic` shape from answers.ts L145-153 context).
  - Wire a per-tick `questionsChanged` flag: the cleanest seam is where `ApplyEffectSinks.recordQuestion` is constructed and where `resolveStaleQuestions` is invoked (grep for its call sites) — both should set a mutable tick-scoped flag owned by the compiler-host tick. After each garden phase completes (compiler-host ~L553 flow and the sub-proposal path ~L1134), if the flag is set: snapshot+clear the flag, then `await runQuestionsChangedSubscribers({...deps})` ONCE (do not loop — a re-set flag waits for the next tick; this is the recursion guard).
  - Resolve path: in `src/engine/host/question-answering.ts`, after the durable answer succeeds and answer handlers ran, call `runQuestionsChangedSubscribers`. Auto-resolution: `question-auto-resolution.ts` runs inside a host tick — set the same flag on each `"answered"`; the tick epilogue dispatch covers it (avoid a second direct call).
- [ ] **Step 4: Run.** `bun test tests/engine/questions-changed.test.ts tests/cli/commands/resolve.test.ts tests/engine/apply-effect.test.ts && bun run typecheck`
- [ ] **Step 5: Commit** — `git commit -am "feat(engine): questions.changed dispatch channel (insert/resolve/stale emit points)"`

---

### Task 5: Move the pure parsers into dome.daily (import direction)

**Files:**
- Create: `assets/extensions/dome.daily/processors/calendar-day.ts` (move `parseCalendarDay`, `parseMeetingLine`, `CalendarMeeting`, `MAX_MEETINGS`/`MAX_TITLE_CHARS`/`MAX_ATTENDEES` from `assets/extensions/dome.agent/lib/brief-shared.ts` L76-148 — verbatim)
- Create: `assets/extensions/dome.daily/processors/sweep-ledger.ts` (move the ENTIRE pure grammar lib from `assets/extensions/dome.agent/lib/sweep-ledger.ts`: `SweepDisposition`, `SweepSettlement`, `SweepRun`, `ParsedSweepLedger`, `parseSweepLedger`, and any pure render helpers it exports — verbatim)
- Modify: `assets/extensions/dome.agent/lib/brief-shared.ts` (delete the moved calendar code; re-export from the new home: `export { parseCalendarDay, type CalendarMeeting } from "../../dome.daily/processors/calendar-day";` so existing dome.agent imports keep working)
- Modify: `assets/extensions/dome.agent/lib/sweep-ledger.ts` → delete; update its importers (`grep -rl "lib/sweep-ledger" assets/ src/ tests/`) to the dome.daily path (sanctioned direction). If `sweep.ts` also has WRITER helpers in that lib, keep writer-side helpers in dome.agent (split the file: pure parse/types → dome.daily; writer/render-for-sweep → stays) — the split criterion is "who must read it": compose-blocks needs parse+types only.
- Test: existing tests keep passing: `bun test tests/extensions/dome.agent tests/processors`

**Interfaces:**
- Produces: `parseCalendarDay(content: string): ReadonlyArray<CalendarMeeting>` and `parseSweepLedger(...)`/`SweepSettlement` importable from dome.daily by Task 6/7. No behavior change anywhere.

- [ ] **Step 1: Move + rewire** exactly as above (this is a refactor task — the tests are the existing suites).
- [ ] **Step 2: Verify no behavior change.** `bun test tests/extensions tests/processors && bun run typecheck` — all green with zero test-body edits (import-path edits in tests are OK).
- [ ] **Step 3: Commit** — `git commit -am "refactor(bundles): move pure calendar/sweep-ledger parsers into dome.daily (sanctioned import direction)"`

---

### Task 6: Edition block identities + renderers (`edition-blocks.ts`)

**Files:**
- Modify: `assets/extensions/dome.daily/processors/daily-types.ts`
- Create: `assets/extensions/dome.daily/processors/edition-blocks.ts`
- Modify: `assets/extensions/dome.search/processors/index-text.ts` (`STRIPPED_SURFACE_BLOCKS` L345-353)
- Test: `tests/extensions/dome.daily/edition-blocks.test.ts` (create)

**Interfaces:**
- Consumes: `generatedBlockMarkers`, `replaceGeneratedBlock`, `findGeneratedBlock` from `src/core/generated-block`; `parseCalendarDay`/`CalendarMeeting` and `SweepSettlement` from Task 5; `resolveQuestionCommand`, `questionAutomationPolicy` from `src/question-resolution` (the imports `action-state.ts` L11-14 already uses); the `OperationalQuestionRow`/`QuestionRecord` row shape from Task 3.
- Produces (exact exports of `edition-blocks.ts`):

```ts
export type EditionQuestion = {
  readonly id: number;
  readonly question: string;
  readonly options: ReadonlyArray<string>;
  readonly automationPolicy: string;   // via questionAutomationPolicy(metadata)
  readonly recommendedAnswer: string | null;
  readonly askedAt: string;
};
export const MAX_EDITION_QUESTIONS = 3;
/** "To decide" — owner-needed first, then oldest askedAt. null when no open questions. */
export function questionsSection(questions: ReadonlyArray<EditionQuestion>): string | null;
/** Deterministic agenda bullets. null when no meetings parse. */
export function agendaSection(meetings: ReadonlyArray<CalendarMeeting>): string | null;
/** Moved+adapted from brief-shared integratedBriefSection: same bullets, wrapped in the dome.daily markers. */
export function integratedSection(rows: ReadonlyArray<SweepSettlement>): string | null;
/** Sources record: entries ONLY for kinds whose day-file exists; null when none exist. */
export function sourcesSection(present: { readonly calendar: boolean; readonly slack: boolean }): string | null;
/** Replace-or-insert one edition block. section === null removes the block (markers included). */
export function replaceEditionBlock(input: {
  readonly content: string;
  readonly owner: string;
  readonly block: string;
  readonly section: string | null;
  readonly heading: string;            // "## Start Here" | "## Meetings"
  readonly afterBlock?: { readonly owner: string; readonly block: string };
}): string;
```

- [ ] **Step 1: daily-types.ts additions.** New names + markers + registry entries (follow the existing const style exactly):

```ts
export const QUESTIONS_BLOCK = "questions";
export const AGENDA_BLOCK = "agenda";
export const INTEGRATED_BLOCK = "integrated";
export const SOURCES_BLOCK = "sources";
export const QUESTIONS_MARKERS = generatedBlockMarkers(DAILY_OWNER, QUESTIONS_BLOCK);
export const AGENDA_MARKERS = generatedBlockMarkers(DAILY_OWNER, AGENDA_BLOCK);
export const INTEGRATED_MARKERS = generatedBlockMarkers(DAILY_OWNER, INTEGRATED_BLOCK);
export const SOURCES_MARKERS = generatedBlockMarkers(DAILY_OWNER, SOURCES_BLOCK);
/** Retired-legacy brief block identities (recognized for migration/anomaly, never written). */
export const LEGACY_BRIEF_QUESTIONS = Object.freeze({ owner: EDITION_YESTERDAY_OWNER, block: "questions" });
export const LEGACY_BRIEF_INTEGRATED = Object.freeze({ owner: EDITION_YESTERDAY_OWNER, block: "integrated" });
export const LEGACY_BRIEF_SOURCES = Object.freeze({ owner: EDITION_YESTERDAY_OWNER, block: "sources" });
```

Append to `DAILY_GENERATED_BLOCKS` (L123-136): the four new `{ owner: DAILY_OWNER, block: * }` entries AND the three legacy brief entries (so anomaly scanning + task-extraction exclusion cover them — verify how the task-extraction excluded set derives from this list vs. a separate list; grep `dailyGeneratedBlockLineRanges` and add the new blocks wherever the exclusion set is defined).
- [ ] **Step 2: Failing renderer tests** in `tests/extensions/dome.daily/edition-blocks.test.ts` — cover per renderer: empty input → `null`; happy path content; questions ordering (owner-needed before older agent-safe), the cap (5 questions in → 3 rendered + `+2 more — \`dome check\`` tail), resolve command lines (`dome resolve 42 <answer>` via `resolveQuestionCommand`); agenda bullet shape `- 09:30 — Title (alice, bob)`; sources omits absent kinds and returns null when none; `replaceEditionBlock` inserts under the heading when absent, after `afterBlock` when given, replaces in place, and removes on `section: null`. Follow the plain-function test style of the repo (no ctx needed).
- [ ] **Step 3: Verify failure, then implement.** Write the renderers. `questionsSection` heading: `### To decide`. Bullet shape (one per question):

```
- Q42 (owner-needed): <question text> — recommended: <recommendedAnswer> — resolve: `dome resolve 42 <value>`
```

(omit the `recommended:` clause when null; options appended like the old `questionsBriefSection` did: ` [opt1 | opt2]`). Plain `-` bullets, never checkboxes. `integratedSection` reuses the moved logic verbatim with the heading `### Integrated Overnight`. `sourcesSection` renders `_Sources: calendar ✓_` style with only present kinds. `replaceEditionBlock` mirrors `replaceBriefBlock` (`brief-shared.ts` L286-326) — copy its insert-under-heading/after-block mechanics, parameterized by owner/block.
- [ ] **Step 4: Search strip list.** Add to `STRIPPED_SURFACE_BLOCKS` in `index-text.ts`: `{owner:"dome.daily", block:"questions"|"agenda"|"integrated"|"sources"}` and `{owner:"dome.agent.brief", block:"questions"|"integrated"|"sources"}` (historical dailies carry the legacy ones). Extend the existing index-text test for one stripped block (grep for the test file covering `STRIPPED_SURFACE_BLOCKS`).
- [ ] **Step 5: Run + commit.** `bun test tests/extensions/dome.daily/edition-blocks.test.ts tests/extensions/dome.search 2>/dev/null || bun test tests/extensions && bun run typecheck` then `git commit -am "feat(dome.daily): edition block identities + deterministic renderers + search strip"`

---

### Task 7: The compositor — `dome.daily.compose-blocks`

**Files:**
- Create: `assets/extensions/dome.daily/processors/compose-blocks.ts`
- Modify: `assets/extensions/dome.daily/manifest.yaml` (new processor stanza; bundle version bump)
- Test: `tests/extensions/dome.daily/compose-blocks.test.ts` (create)

**Interfaces:**
- Consumes: everything Task 6 exports; `renderDailySkeleton` (`daily-scaffold.ts` L43), `dailyPath`/`localDateParts`/`previousLocalDate`/`parseScheduleInput`/`dailyPathSettings` (`daily-paths.ts`), `generatedBlockAnomalyDiagnostics` (`src/core/generated-block-diagnostics`), `patchEffect`/`diagnosticEffect` (`src/core/effect`), `ctx.operational.questions` (Task 3), `parseCalendarDay` + `parseSweepLedger` (Task 5).
- Produces: the processor default export; manifest id `dome.daily.compose-blocks`.

- [ ] **Step 1: Failing processor tests** (template: `tests/processors/daily-close-scaffold.test.ts` — copy its `fakeSnapshot`, `makeProcessorContext` usage, `runX(files, input?)` helper returning `{patch, written}`). Pass `operational` into `makeProcessorContext` as a stub view: `{ outbox: () => [], quarantines: () => [], orphanRuns: () => [], questions: () => SEEDED }`. Cases:
  1. **Questions render:** 2 open questions (one owner-needed, one agent-safe older) → written daily contains `dome.daily:questions` block, owner-needed first, resolve command lines present.
  2. **Loud missing view:** context with NO `operational` → effects contain a warning `diagnostic` with `code: "dome.daily.questions-view-missing"`, and the written content (if any patch) has no questions block.
  3. **Agenda:** `sources/calendar/<today>.md` present in snapshot → `dome.daily:agenda` block with parsed bullets; absent → no agenda block.
  4. **Integrated:** `meta/sweep-ledger.md` with a `## Run <today>` section → integrated block; absent/empty → none.
  5. **Sources:** calendar file present, slack absent → `_Sources: calendar ✓_` only; neither → no sources block at all.
  6. **Skeleton creation:** no daily in snapshot → patch writes full skeleton + blocks.
  7. **Legacy migration:** daily containing `<!-- dome.agent.brief:questions:start -->…:end -->` (and integrated/sources) → written content has the legacy blocks REMOVED and the new `dome.daily:*` blocks present; historical daily paths are never touched (the patch's only change path is today's daily).
  8. **Idempotency:** running over its own output with unchanged inputs → NO patch effect.
  9. **Empty-set removal:** daily already carrying a questions block, `questions: () => []` → written content no longer contains the block.
- [ ] **Step 2: Verify failure.** `bun test tests/extensions/dome.daily/compose-blocks.test.ts`
- [ ] **Step 3: Implement `compose-blocks.ts`.** Structure (mirror close-scaffold's shape: header comment, `defineProcessor`-style default export, pure helpers below):
  - Target date: `parseScheduleInput(ctx.input)?.firedAt ?? ctx.now()` → `localDateParts` (carry-forward L163-168 pattern). `todayPath = dailyPath(date, dailyPathSettings(ctx.extensionConfig))`.
  - `existing = await ctx.snapshot.readFile(todayPath)`; base content = existing ?? `renderDailySkeleton({ today, yesterday: previousLocalDate(date), settings })`.
  - Questions: `const view = ctx.operational?.questions; if (view === undefined) { diagnostics.push(diagnosticEffect({ severity: "warning", code: "dome.daily.questions-view-missing", message: "dome.daily.compose-blocks declares questions.read but received no questions view; the To-decide block is omitted", ... })) }` else map rows → `EditionQuestion` (use `questionAutomationPolicy(effect.metadata)`, `effect.metadata?.recommendedAnswer ?? null`) → `questionsSection(...)`.
  - Compose: apply `replaceEditionBlock` for questions (heading `## Start Here`, afterBlock = `EDITION_YESTERDAY_BLOCK` when present, else insert at top of the section), integrated (afterBlock questions), sources (afterBlock integrated), agenda (heading `## Meetings`, top). Then remove legacy blocks: for each of `LEGACY_BRIEF_QUESTIONS/INTEGRATED/SOURCES`, `replaceEditionBlock({ content, owner, block, section: null, heading: "## Start Here" })` (removal ignores heading).
  - Anomaly scan: `generatedBlockAnomalyDiagnostics({ content: existing ?? "", path: todayPath, code: "dome.daily.generated-block-anomaly", blocks: DAILY_GENERATED_BLOCKS, sourceRef: ctx.sourceRef(todayPath) })` (carry-forward L72-78 pattern).
  - If composed === existing → return diagnostics only. Else return diagnostics + one `patchEffect({ mode: "auto", changes: [{ kind: "write", path: todayPath, content: composed }], reason: \`dome.daily: compose deterministic edition blocks in ${todayPath}\`, sourceRefs: [ctx.sourceRef(todayPath)] })`.
  - Purity: no imports beyond core/effect, core/generated-block(-diagnostics), question-resolution, sibling processor files. Time only via `ctx.now()`.
- [ ] **Step 4: Manifest stanza** (after the close-scaffold stanza; bump bundle `version` minor):

```yaml
  - id: dome.daily.compose-blocks
    version: 0.1.0
    phase: garden
    triggers:
      - kind: schedule
        cron: "25 5 * * *"
      - kind: signal
        name: questions.changed
      - kind: signal
        name: file.created
        pathPattern: "sources/calendar/*.md"
      - kind: signal
        name: file.created
        pathPattern: "sources/slack/*.md"
      - kind: signal
        name: document.changed
        pathPattern: "sources/calendar/*.md"
      - kind: signal
        name: document.changed
        pathPattern: "sources/slack/*.md"
      - kind: signal
        name: file.created
        pathPattern: "meta/sweep-ledger.md"
      - kind: signal
        name: document.changed
        pathPattern: "meta/sweep-ledger.md"
    capabilities:
      - kind: read
        paths:
          - "wiki/dailies/*.md"
          - "sources/calendar/*.md"
          - "sources/slack/*.md"
          - "meta/sweep-ledger.md"
      - kind: patch.auto
        paths: ["wiki/dailies/*.md"]
      - kind: questions.read
    execution:
      class: deterministic
    module: processors/compose-blocks.ts
```

- [ ] **Step 5: Run.** `bun test tests/extensions/dome.daily && bun test tests/integration/processor-purity.test.ts tests/integration/generated-block-splice-guard.test.ts tests/integration/bundle-matrix-lockstep.test.ts && bun run typecheck` — if bundle-matrix-lockstep fails, update the matrix doc it names (`docs/wiki/matrices/extension-bundle-shape.md` or similar) with the new processor row.
- [ ] **Step 6: Commit** — `git commit -am "feat(dome.daily): compose-blocks — deterministic owner for questions/agenda/integrated/sources"`

---

### Task 8: Slim the brief + compose-record gate

**Files:**
- Modify: `assets/extensions/dome.agent/processors/brief.ts`
- Modify: `assets/extensions/dome.agent/lib/brief-shared.ts`
- Modify: `assets/extensions/dome.agent/manifest.yaml` (brief version bump only; capabilities unchanged — the ledger read stays for the compose-record hash)
- Test: `tests/extensions/dome.agent/brief.test.ts` (update), `tests/extensions/dome.agent/brief-shared.test.ts` if present

**Interfaces:**
- Consumes: `EDITION_YESTERDAY_BLOCK`; existing `replaceBriefBlock`, `extractBriefBlockBody`.
- Produces (in `brief-shared.ts`):

```ts
export const COMPOSE_RECORD_BLOCK = briefBlock("compose-record");
export type BriefComposeRecord = {
  readonly count: number;                       // composes today
  readonly time: string;                        // "HH:MM" vault-local, from ctx.now()
  readonly inputs: { readonly calendar: string; readonly slack: string; readonly ledger: string; readonly yesterday: string }; // 8-hex FNV-1a or "—"
};
export function composeRecordSection(record: BriefComposeRecord): string;
export function parseBriefComposeRecord(content: string): BriefComposeRecord | null;
/** Pure FNV-1a 32-bit → 8-hex; "—" for null/absent input. */
export function inputFingerprint(content: string | null): string;
export const MAX_DAILY_COMPOSES = 3;
```

Record line shape: `_Composed 2× 09:12 · calendar@a3f29b01 · slack@— · ledger@9b1c00ff · yesterday@77e01234_`

- [ ] **Step 1: Failing tests.** In the brief test file (using its `makeCtx`):
  1. **Gate skip:** daily already contains a compose-record whose hashes match current inputs → `brief.run` returns `[]` with ZERO model steps consumed (assert via a `stepFn` that throws if called).
  2. **Gate re-compose:** record present but calendar hash differs (new calendar file content) → compose proceeds; written daily's record carries the new hash and `count` incremented.
  3. **Cap:** record with `count: 3` and stale hashes → returns only an `info` diagnostic (`code: "dome.agent.brief-compose-cap"`), no model call, no patch.
  4. **No legacy blocks written:** a successful compose's written daily contains NO `dome.agent.brief:questions|integrated|sources` markers, and DOES contain the compose-record block as the last block of `## Start Here`.
  5. **Failure stub:** the `composedAlready` branch keys off `parseBriefComposeRecord` (adapt the existing failure-stub tests).
  Also unit tests for `inputFingerprint` (stable, 8 hex chars, `"—"` on null) and `composeRecordSection`/`parseBriefComposeRecord` round-trip.
- [ ] **Step 2: Verify failure**, then **implement**:
  - `brief-shared.ts`: add the exports above; DELETE `questionsBriefSection`, `sourcesBriefSection`, `parseBriefSourcesSeen`, `BriefSourcesSeen`, `integratedBriefSection` (moved in Task 6), `staleLoopsFromFacts`, `staleLoopsTaskLines` (dead with the projection reads). KEEP `QUESTIONS_BLOCK`/`INTEGRATED_BLOCK`/`SOURCES_BLOCK` constants with a `retired-legacy` comment (the brief's anomaly scan still recognizes them; compose-blocks owns removal).
  - `brief.ts`:
    - Replace the sources-seen gate (L153-162): compute `current = { calendar: inputFingerprint(calendarContent), slack: inputFingerprint(slackContent), ledger: inputFingerprint(todayLedgerSection), yesterday: inputFingerprint(yesterdayDailyContent) }`; parse the record from the existing daily; **on a `garden` (signal) fire:** record `null` → return `[]` (first compose belongs to the cron/manual run — preserves the old contract); all hashes match → return `[]`; `count >= MAX_DAILY_COMPOSES` → info diagnostic only. **On a `schedule` fire:** proceed when record is null (first compose) or hashes differ (respect the cap); all-match → return `[]`.
    - Delete: the questions batch (L504-518), the integrated splice + ledger→`todayRuns` wiring feeding it (L520-533; keep the ledger READ — the today-section text is a fingerprint input), the sources-seen write (L457-466), the stale-loops projection reads (L266-288) and their `taskTurn` feed (`staleLoopsTaskLines` at ~L765), and every remaining `ctx.projection` mention (grep the file to zero).
    - Add: after the narrative splices, write the compose-record via `replaceBriefBlock({ content, markers: COMPOSE_RECORD_BLOCK, section: composeRecordSection({ count: prevCount + 1, time, inputs: current }), heading: "## Start Here" })` — placed at section end (no `afterBlock`). Update the failure-stub `composedAlready` (L342) to `parseBriefComposeRecord(existing) !== null`.
    - `taskTurn` prompt (L694-775): meetings instruction now says the deterministic agenda block already lists the schedule; the meetings block must add prep context only (people, prior decisions, open threads) and never restate the agenda list.
    - Anomaly scan list (L542-564): keep all six legacy+live brief blocks + add COMPOSE_RECORD_BLOCK.
  - Update every brief test that asserted questions/integrated/sources composition — those move to compose-blocks tests (Task 7 covered them); delete or rewrite the brief-side assertions.
- [ ] **Step 3: Run.** `bun test tests/extensions/dome.agent && bun run typecheck`
- [ ] **Step 4: Commit** — `git commit -am "feat(dome.agent): slim brief to narrative blocks behind the compose-record fingerprint gate"`

---

### Task 9: End-to-end fence + full verification

**Files:**
- Create: `tests/harness/scenarios/effect-routing/questions-changed-compose.scenario.test.ts` (model on `tests/harness/scenarios/cli-surface/answer-question.scenario.test.ts` — same `scenario(...)` harness)
- Possibly modify: `docs/wiki/matrices/*` if lockstep tests flag the new processor/signal/capability

**Interfaces:** Consumes everything; produces the end-to-end guarantee.

- [ ] **Step 1: Scenario test.** Using the harness: enable dome.daily; drive a flow where (a) a question is asked by a fixture processor → the engine tick ends → today's daily contains the `dome.daily:questions` block with that question; (b) `dome resolve <id> <value>` → after the resolve completes, today's daily no longer lists it (block updated or removed). Assert on the file content at the adopted head, and assert the compose commit is engine-authored. If the harness cannot drive the resolve→dispatch path directly, drive `runQuestionsChangedSubscribers` at the same seam the host uses and assert the adopted daily updated — the test must cross the engine boundary, not call the processor directly.
- [ ] **Step 2: Sweep the fences.** `bun test tests/integration tests/invariants` — fix any lockstep fallout (matrix docs, schema-type lockstep, bundle deps).
- [ ] **Step 3: Full gate.** `bun run typecheck && bun test ./tests` — if unrelated tests flake under parallel load (known repo caveat), re-run the failing files in isolation and record which ones were pre-existing flakes.
- [ ] **Step 4: Commit** — `git commit -am "test(harness): questions.changed end-to-end — ask renders, resolve clears"`

---

## Self-review notes (already applied)

- Spec coverage: design §1a→Tasks 2+4, §1b→Task 3, §2→Tasks 6+7, §3→Task 8, degradation ladder→tests in Tasks 7+8, spec-first discipline→Task 1, search strip + DAILY_GENERATED_BLOCKS registration→Task 6, matrices→Tasks 7+9.
- The sources-block "enabled subscription" clause from the design is narrowed to file-presence only (a dome.daily processor cannot read dome.sources config); the design doc's intent — no perpetual dead line — is preserved and strengthened.
- Type consistency: `EditionQuestion`, `InsertQuestionResult`, `QuestionsChangedOptions`, `BriefComposeRecord`, `replaceEditionBlock` are each defined once (Tasks 6/4/4/8/6) and consumed by name elsewhere.
