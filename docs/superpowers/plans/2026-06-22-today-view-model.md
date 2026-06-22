# Today View-Model — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the `dome.daily.today` surface into the exemplar of a three-tier **surface view-model** pattern: a single validated payload contract (`dome.daily.today/v1`) that the producer emits and every consumer validates against → a consumer-side view-model that owns the semantic decisions (urgency, hero-dedup, sections) → adapters that only paint. Kills the four parallel hand-maintained understandings of the today shape and the duplicated CLI/HTTP classification logic; closes the accidental CLI↔HTTP grouping drift as a consequence.

**Architecture (grilled 2026-06-22):** The candidate started as "CLI and HTTP duplicate today rendering" but grilling found the deeper gap — the `dome.daily.today/v1` "contract" is a **string tag with zero enforcement** (`view-catalog.ts:49`), so the producer (`assets/extensions/dome.daily/processors/today.ts`), the consumer parser (`src/surface/today-view.ts`), the MCP narrowing (`src/mcp/server.ts`), and the agent tools (`src/agent/tools.ts` — which carries a *comment* re-deriving the shape and a battle scar: "sourceRefs is a PLURAL ARRAY") each keep their own copy. Three tiers:

| Tier | What | Decision |
|---|---|---|
| **1 · Payload contract** | `dome.daily.today/v1` | One **zod schema** = the contract. `type TodayPayload = z.infer<schema>`. Producer imports the **erased type** (zero runtime zod dep) and constructs its `ViewEffect` data to it; consumers **validate via the schema** at the deserialization boundary. Leniency (today's `date` default, count fallbacks, drop-malformed-rows) encoded *into* the schema via `.catch()`/`.default()` — no behavior change. |
| **2 · View-model** | consumer-derived | `buildTodayViewModel(payload): TodayViewModel` — per-task `TaskUrgency` classification, hero-dedup, five typed sections, `totalOpen`. Consumer-only; the producer doesn't compute these. |
| **3 · Paint** | adapters | CLI + HTTP iterate the shared sections; no local classification/dedup/bucketing. |

Key shape decisions (grilled):
- **`TaskUrgency`** = `overdue{days} | due-today | this-week{date} | later{date} | someday`. `someday` (undated) is **split from** `later` (dated-but-far) — a free, more-useful distinction; adapters may merge when painting.
- **Five sections** (`overdue / dueToday / thisWeek / later / someday`), hero-deduped. The canonical grouping. **This is the one intended behavior change:** CLI gains `this-week` + `someday` sections (it currently lumps all future+undated into one "later"); HTTP gains `someday`. The accidental drift closes because the partition is computed once.
- **No stored `isAllClear` bool** — expose **`totalOpen: number`** (the "N open" headline both surfaces render); all-clear is `totalOpen === 0` at use sites.
- **No per-row `urgency` field** — a row's urgency *is* its section; only the hero carries explicit `heroUrgency` (it sits outside the sections and needs `days`/`date` for its pill).
- **`buildTodayViewModel` is a separate layer** above `parseTodayView`, both in `today-view.ts`. `parseTodayView` keeps its name/signature (now schema-backed) so existing consumers/tests are unaffected; it still applies the wikilink transforms (`stripWikilinks`, entity/origin extraction).

**Scope: L2.** Today is the proving exemplar; the pattern is written down (`docs/wiki/concepts/surface-view-model.md`); `status` is nominated as instance #2. The generic per-view schema-validation layer in the view-catalog (L3) is **deferred** — extract it only once `status` is a second concrete contract (design-it-twice on two real instances).

**Tech Stack:** TypeScript, Bun, zod (already a dep), the four-concept Dome engine.

## Global Constraints

- **Canonical gate:** `bun test ./tests` (NOT bare `bun test`). Full-repo `tsc` is pre-existing red; verify touched files are clean via `bunx tsc --noEmit 2>&1 | grep <file>`. PWA suite only if `pwa/` touched.
- **One intended behavior change, everywhere else preserved.** The CLI/HTTP *rendered output changes only* by gaining the new sections (`this-week`/`someday`). Every other adapter test must stay green verbatim. The intended golden-test updates (CLI `today.test.ts`, HTTP `today-html.test.ts`) are made deliberately, each with a comment citing this plan — they are the *expected* diff, not drift. If any *other* adapter test needs editing, STOP.
- **Producer keeps zero runtime zod dependency.** The producer imports `type TodayPayload` only (erased). **Verify** the bundle-deps fence (`tests/integration/bundle-deps.test.ts`) and the no-direct-mutation/import-direction fences tolerate a type-only import edge from `assets/extensions/dome.daily/` into `src/surface/today-view.ts`. If a static dep-scan flags the erased edge, define `TodayPayload` in a zero-dep contract module and have the zod schema `satisfies z.ZodType<TodayPayload>` (type defined once, schema conforms).
- **Leniency is preserved, not tightened.** The schema must reproduce today's forgiving parse (default `date`, count fallbacks to array lengths, drop malformed rows, null-safe brief/calendar/hero). Use `.catch()`/`.default()`; do not introduce throws on partial payloads.
- **Commit trailer:** end commit messages with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Worktree per the repo convention (`.claude/worktrees/today-view-model/build` → `--no-ff` merge → delete). Restart the `dome serve` daemons after merge to pick up the producer change.

## File structure

- `src/surface/today-view.ts` (MODIFY) — add `todayPayloadSchema` + `type TodayPayload`; reimplement `parseTodayView` as schema-validate + wikilink transforms; add `TaskUrgency`, `TodaySections`, `TodayViewModel`, `buildTodayViewModel`. Keep `addDays`/`daysBetween`.
- `tests/surface/today-view.test.ts` (MODIFY) — keep the existing parse assertions green; add `buildTodayViewModel` unit tests.
- `tests/surface/today-payload.test.ts` (NEW) — schema validation + leniency cases.
- `assets/extensions/dome.daily/processors/today.ts` (MODIFY) — type the emitted `ViewEffect` data as `TodayPayload` (erased type import).
- `src/cli/commands/today.ts` (MODIFY) — `formatTodayResult` consumes `buildTodayViewModel`; render five sections; drop local urgency/dedup/bucket logic.
- `src/http/today-html.ts` (MODIFY) — `renderTodayHtml` consumes `buildTodayViewModel`; render sections; drop local logic.
- `src/mcp/server.ts`, `src/agent/tools.ts` (MODIFY) — validate via `todayPayloadSchema`; delete the re-derivation comment + ad-hoc narrowing.
- `tests/cli/commands/today.test.ts`, `tests/http/today-html.test.ts` (MODIFY) — update goldens for the intended new sections only.
- `docs/wiki/concepts/surface-view-model.md` (NEW), `docs/index.md`, `docs/wiki/specs/sdk-surface.md` (MODIFY) — the convention; nominate `status` as instance #2.

---

### Task 1: The `dome.daily.today/v1` payload contract (tier 1)

**Files:** Modify `src/surface/today-view.ts`; create `tests/surface/today-payload.test.ts`.

**Why:** The `/v1` schema is a string tag validated by nothing; four consumers hand-maintain the shape. This makes the schema the single source.

- [ ] **Step 1 — failing test.** In `tests/surface/today-payload.test.ts`, assert `todayPayloadSchema.parse` (a) accepts a full valid payload, (b) reproduces today's leniency: missing `date` → `"today"`, missing `counts` → array-length fallbacks, malformed task rows dropped, absent `brief`/`calendar`/`hero` → null. Mirror the cases currently covered by `tests/surface/today-view.test.ts`. Run, expect FAIL (no schema yet).
- [ ] **Step 2 — define the schema + type** in `today-view.ts`: `export const todayPayloadSchema = z.object({…})` with `.catch()`/`.default()` matching the leniency; `export type TodayPayload = z.infer<typeof todayPayloadSchema>`. The payload fields mirror the current `TodayView` (date, openTasks, followups, questions, brief, calendar, hero, counts).
- [ ] **Step 3 — reimplement `parseTodayView`** as `todayPayloadSchema.parse(data)` followed by the existing wikilink transforms (`stripWikilinks` on task/question/hero text, `wikilinkSlugs`/`origin` extraction) — either as zod `.transform()`s or a thin post-parse map. Keep the exported name + return type so existing consumers/tests are unchanged.
- [ ] **Step 4 — verify the dep fences** per Global Constraints (type-only edge from the producer). Run, expect PASS — `bun test ./tests/surface ./tests/integration/bundle-deps.test.ts`.
- [ ] **Step 5 — commit** (`feat(surface): dome.daily.today/v1 as a validated zod contract`).

### Task 2: Producer types its output to the contract (tier 1)

**Files:** Modify `assets/extensions/dome.daily/processors/today.ts`.

- [ ] **Step 1** — import `type { TodayPayload }` from `src/surface/today-view` (erased). Type the object passed to `viewEffect({ data: { kind: "structured", schema: SCHEMA, …payload } })` as `TodayPayload`, so the producer is compile-time-checked to emit the contract. Reconcile/retire the producer's parallel local types (`DailyHero`, `DailyBriefField`) where they now duplicate the contract.
- [ ] **Step 2** — `bunx tsc --noEmit 2>&1 | grep "dome.daily/processors/today.ts"` clean; `bun test ./tests/extensions/daily-today-view.test.ts ./tests`.
- [ ] **Step 3 — commit** (`refactor(dome.daily): producer types today output to the /v1 contract`).

### Task 3: `buildTodayViewModel` (tier 2)

**Files:** Modify `src/surface/today-view.ts`; extend `tests/surface/today-view.test.ts`.

- [ ] **Step 1 — failing tests** for `buildTodayViewModel(payload)`: `TaskUrgency` classification (overdue with `days`, due-today, this-week vs later boundary at +7, someday for null due), hero-dedup (path:line:text identity removed from sections), the five sections, `heroUrgency`, `totalOpen`. Run, expect FAIL.
- [ ] **Step 2 — implement** `buildTodayViewModel`, `TaskUrgency`, `TodaySections`, `TodayViewModel` per the Architecture shape. Pure function of the payload (`date` is `payload.date`). Run, expect PASS.
- [ ] **Step 3 — commit** (`feat(surface): buildTodayViewModel — urgency, hero-dedup, sections`).

### Task 4: CLI paints the view-model (tier 3)

**Files:** Modify `src/cli/commands/today.ts`; update `tests/cli/commands/today.test.ts` goldens (intended new sections only).

- [ ] **Step 1** — `formatTodayResult` calls `buildTodayViewModel(parseTodayView(data))`; render hero via `heroUrgency`, sections via `stillOpen`; delete the local overdue/dueToday/open filters, `isHeroTask` dedup, and inline urgency strings. Keep CLI-only presentation (glyphs, paint, entity-clustering within a section, `shortenLabel`, overflow "N more" math via `counts`/`totalOpen`).
- [ ] **Step 2** — update the today goldens for the *intended* change (CLI now shows `this-week`/`someday` sections), each with a comment citing this plan. Every other assertion stays. Run `bun test ./tests/cli/commands/today.test.ts ./tests`.
- [ ] **Step 3 — commit** (`refactor(cli): today renders the shared view-model; gains this-week/someday sections`).

### Task 5: HTTP paints the view-model (tier 3)

**Files:** Modify `src/http/today-html.ts`; update `tests/http/today-html.test.ts` goldens (someday section only).

- [ ] **Step 1** — `renderTodayHtml` consumes `buildTodayViewModel`; render hero via `heroUrgency`, sections via `stillOpen`; delete `heroKey` dedup, `renderHeroHtml`'s urgency if/else, and `renderStillOpenHtml`'s local bucketing. Keep HTTP-only presentation (CSS, spans, `clampText`, calendar/question HTML).
- [ ] **Step 2** — update goldens for the intended `someday` section; everything else green. `bun test ./tests/http/today-html.test.ts ./tests`.
- [ ] **Step 3 — commit** (`refactor(http): today-html renders the shared view-model`).

### Task 6: MCP + agent tools validate via the contract (tier 1 cleanup)

**Files:** Modify `src/mcp/server.ts`, `src/agent/tools.ts`.

- [ ] **Step 1** — replace the MCP `tasks`/`brief` ad-hoc narrowing and the `agent/tools.ts` "Real dome.daily.today/v1 shape" comment + hand-derivation with a `todayPayloadSchema`-validated `TodayPayload` (or `buildTodayViewModel` where they need the derived sections). Delete the battle-scar comment — the type now enforces it.
- [ ] **Step 2** — `bun test ./tests/mcp ./tests/agent ./tests` (and `cd pwa && bun test` only if the PWA consumes the `/agent` today shape).
- [ ] **Step 3 — commit** (`refactor(mcp,agent): consume the today payload via the shared schema`).

### Task 7: Write the surface-view-model convention (L2 deliverable)

**Files:** Create `docs/wiki/concepts/surface-view-model.md`; modify `docs/index.md`, `docs/wiki/specs/sdk-surface.md`.

- [ ] **Step 1** — write the convention: a surface view = **(1)** a validated payload contract (`/vN` ⇒ one schema, producer emits, consumers validate) → **(2)** an optional consumer view-model for derived presentation semantics → **(3)** thin protocol painters. Use `today` as the worked exemplar; **nominate `status` as instance #2**; note the generic per-view validation layer (L3) is deferred until a second contract exists (design-it-twice).
- [ ] **Step 2** — link it from `docs/index.md` (orientation line, by `[[philosophy]]`/`[[glossary]]`) and reference it from `sdk-surface.md` §"Consumer surfaces". Verify wikilinks resolve.
- [ ] **Step 3 — commit** (`docs: surface-view-model convention; today as exemplar, status next`).

---

## Self-Review

- **Tiers, sequenced for safety.** Tier 1 (Tasks 1–2, 6) lands the validated contract; tier 2 (Task 3) is additive; tier 3 (Tasks 4–5) swaps adapters to painters. Each task ends green; the only intended output change is the new CLI/HTTP sections, gated by deliberate golden updates.
- **The producer stays zod-free at runtime** (erased type import) — verified against the bundle-deps fence, with a documented fallback (zero-dep type module + `satisfies`) if the static scan flags the edge.
- **Leniency preserved.** The schema encodes today's forgiving parse; no new throws on partial payloads.
- **L2 discipline held.** One concrete exemplar + the written convention + `status` nominated; the generic view-catalog validation layer (L3) is deferred to design-it-twice against two real contracts, not guessed from one.
- **Risk ranking:** Task 1 (the contract + leniency) and Tasks 4–5 (adapter output, golden changes) are highest-risk → per-task review + full suite. Tasks 2/3/6/7 → tests-green + diff check.
