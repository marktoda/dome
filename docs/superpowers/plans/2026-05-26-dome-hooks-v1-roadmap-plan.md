# Dome hooks v1 — phased roadmap plan

> **Status:** Roadmap plan. Phase-shaped, not task-shaped — each phase will spawn its own per-feature implementation plan in this directory once it's ready to execute. Use this doc to sequence the work, identify gates, and check dependencies.
>
> **First execution session scope (2026-05-26, post-refactor):** Phase 0 + Phase 1 skeleton (no LLM compile-on-write — that's Phase 2, deferred). Implementation goes through the cohesive workflow: `cohesive:rewrite-specs` → `cohesive:validate-rewrite` → `cohesive:implement-cohesively` → dual reviewer. Lands on a branch for review; merge is a separate step.
>
> **Gate decisions locked for the first session:**
> - Carry-forward semantics: **copy-with-backref** (yesterday keeps lines; today gets copies with footer attribution; deduplication is the future task-index's job).
> - Bundle split: **split by lifecycle** — `dailies`, `aggregation`, `recall` as separate bundles.
> - Migration path: **`dome migrate-dailies` one-shot command** — moves `notes/<YYYY-MM-DD>.md` to `wiki/dailies/<YYYY-MM-DD>.md`, rewrites frontmatter + wikilinks, no-ops on already-migrated vaults.
> - Out-of-scope for this session (Phase 2 gates): compile trigger timing, LLM call location.
>
> **Builds on:** [`docs/cohesive/brainstorms/2026-05-26-dome-hooks-v1-roadmap.md`](../../cohesive/brainstorms/2026-05-26-dome-hooks-v1-roadmap.md) — the product brainstorm (what we want).
>
> **Baseline (landed in main):** [`docs/cohesive/delta-ledgers/2026-05-26-dome-v0.5-to-v1-tightening.md`](../../cohesive/delta-ledgers/2026-05-26-dome-v0.5-to-v1-tightening.md) — the v0.5-to-v1 tightening refactor (F1–F8) merged at `e139ae7`. All references below treat that refactor's substrate as the baseline.

**Goal:** Ship the four-layer hook system from the brainstorm (rhythm → compile-on-write keystone → aggregation → recall), with the dogfood case being Mark's daily/weekly note workflow. Use the work to prove out the extension-bundle surface that v1 features depend on.

**Audience priority:** Mark dogfood → curated first-party templates → plugin ecosystem (deferred post-v1).

---

## Phase summary

| Phase | Goal | Blocks | Unblocks | Rough size |
|---|---|---|---|---|
| **0** | Substrate enablement — close G1, G3, G4, G5, G6 from the brainstorm | (refactor landed) | All downstream phases | 2-3 weeks |
| **1** | Ship dailies as the first extension bundle (proves the bundle surface) | Phase 0 (G3, G1) | Phases 2-3 | 1-2 weeks |
| **2** | Compile-on-write keystone — daily edits → wiki updates | Phase 1 | Phases 3-4 (sharper) | 3-4 weeks |
| **3** | Aggregation & reflection — weekly rollups, monthly retros, stale-thread surface | Phase 2 (L2.1/L2.2) | (Phase 4 sharper) | 1 week |
| **4** | Recall workflows — "plan today?", "talk to X?", "last month?" | (None — can start early at reduced fidelity) | — | 1 week |

**Concurrency:** Phase 0 ships in parallel internally (G1/G3/G4/G5/G6 are independent). Phase 4 can dogfood against the current `~/vaults/work/notes/` vault before Phase 1 lands; it sharpens once Phases 1-3 produce structured outputs.

**Total:** ~8-11 weeks calendar, with overlap.

---

## Phase 0 — substrate enablement

**Goal:** Close the five extensibility gaps the brainstorm surfaced. After Phase 0, "ship a feature as an extension bundle" is a known recipe.

**Per-feature plans to write (each becomes its own plan doc in this directory):**

- `dome-hooks-v1-phase-0a-extension-bundle-loader.md` (G3)
- `dome-hooks-v1-phase-0b-agents-md-preamble-fragments.md` (G3 continuation)
- `dome-hooks-v1-phase-0c-schedule-field.md` (G1)
- `dome-hooks-v1-phase-0d-upsert-section-helper.md` (G5)
- `dome-hooks-v1-phase-0e-dome-run-hook-command.md` (G4)

### 0a — Extension bundle loader (G3)

**Deliverable.** Directory shape `.dome/extensions/<name>/` recognized at vault load. Loader extends the v0.5.1 `loadDeclarativeHooks` + `page-types.yaml` paths to iterate extension directories. Each bundle contains optional `manifest.yaml`, `page-types.yaml`, `preamble.md`, `workflows/*.md`, `hooks/*.yaml`.

**Pattern.** Follow the refactor's "Adding a new X is N file edits" recipe. Add `## Adding a new extension bundle` recipe section to `docs/wiki/specs/sdk-surface.md` *first*; implement to match.

**Substrate changes.**
- New spec recipe in `sdk-surface.md`.
- Page-types.yaml extension records gain optional `source:` field (`"vault" | "extension:<name>"`) for attribution.
- New gotcha: `extension-bundle-load-order` — bundles load alphabetically; later bundles can't shadow earlier page-types; preamble fragments append in load order.
- Zod schema for the new `manifest.yaml` (follows F6's Zod-everywhere pattern).

**Acceptance.** A test bundle at `tests/fixtures/extensions/hello-world/` declares a `hello` page type, a hook reacting to `clock.tick.minutely`, and a preamble fragment — and on `openVault`, the page-type registers, the hook fires, and AGENTS.md regeneration includes the preamble.

### 0b — AGENTS.md preamble fragments (G3 continuation)

**Deliverable.** `src/agents-md.ts buildAgentsMdTemplated` accepts an array of preamble fragments contributed by loaded extension bundles. New section in templated output: `## Extension conventions` with one subsection per bundle's `preamble.md`. Idempotent across `--repair` (user-prose section still preserved verbatim).

**Substrate changes.**
- `AGENTS_MD_IS_ORIENTATION_SURFACE.md` invariant extended: templated section now also carries extension preamble fragments; the lockstep test (`tests/invariants/agents-md-is-orientation-surface.test.ts`) asserts ordering and idempotency.
- Existing `agents-md-delimiter-shape` gotcha (added in the refactor) extends naturally — no new gotcha needed.

**Acceptance.** Loading the dailies bundle (Phase 1) results in AGENTS.md containing a `## Extension conventions / ### Dailies` subsection describing how dailies work; running `dome doctor --repair` after user edits to the user-prose section preserves the user prose and regenerates the extension section in place.

### 0c — `schedule:` field on declarative hooks (G1)

**Deliverable.** Declarative hook YAML accepts `schedule: "<cron>"` alongside `event:`. Loader validates with Zod. Dispatcher wakes a scheduler (per-vault, in-process) that fires the hook on schedule by synthesizing a `clock.tick.scheduled` event with the hook's id in the payload.

**Substrate changes.**
- `docs/wiki/specs/hooks.md` §"Adding a new hook" recipe (added in the refactor) extends with a `schedule:` example.
- Extend `DeclarativeHookSchema` (added in F6) to accept `schedule: string` (cron validated by Zod).
- Persistence: scheduler state lives in `.dome/state/scheduled.json` (already partially exists per reconcile.ts phase 3 — extend, don't duplicate).

**Acceptance.** A hook with `schedule: "0 6 * * *"` fires daily at 6am wall-clock time and is skipped on `dome reconcile` replay (non-idempotent by default for scheduled hooks unless explicitly declared idempotent).

### 0d — `tools.upsertSection(path, sectionKey, content)` helper (G5)

**Deliverable.** New tool on `BoundToolSurface`: `upsertSection(path, sectionKey, content) → Promise<Result<Effect, ToolError>>`. Reads doc; finds `<!-- section:sectionKey -->` markers (or creates them if absent); replaces or inserts content idempotently. Returns the same `Effect` shape as `writeDocument` so events project normally.

**Substrate changes.**
- New tool entry in `docs/wiki/specs/sdk-surface.md` §"Tools" table.
- Extends the `BoundToolSurface` interface in `src/hook-context.ts`.
- Lockstep: `tests/integration/tool-surface-shape.test.ts` (or similar) gains the new tool.

**Acceptance.** Calling `upsertSection` twice with the same `(path, sectionKey, content)` produces one write the first time and zero writes the second (effect array empty); calling with new content updates in place.

### 0e — `dome run-hook <id>` CLI command (G4)

**Deliverable.** New CLI command (9th — bumps the count again). Takes a hook id; synthesizes a manual-trigger event (`hook.manual.invoked` with `--event.path=...` and `--event.payload-json=...` flags); dispatches it as if it had fired naturally.

**Substrate changes.**
- `docs/wiki/specs/cli.md` gains a `## dome run-hook` section using the recipe.
- New event type `hook.manual.invoked` projected into `event-projection.ts`.
- Update the `cli-five-commands-deterministic-comment` (or whatever the count is post-refactor) — `run-hook` is non-deterministic by definition.

**Acceptance.** `dome run-hook compile-daily --event.path=wiki/dailies/2026-05-26.md` invokes the compile-daily hook against the named file without waiting for a save event; useful for backfill and dogfood.

### Phase 0 acceptance signal

A skeleton test bundle (`tests/fixtures/extensions/hello-world/`) loads cleanly, registers a page type, contributes a preamble fragment, runs on a `schedule:`, can be manually triggered with `dome run-hook`, and a manual upsertSection call against a test page is idempotent. Once all five gap items pass, Phase 1 is unblocked.

---

## Phase 1 — ship dailies as the first extension bundle

**Goal:** Mark's daily/weekly note workflow runs as a real extension bundle. Proves the bundle surface end-to-end on a non-trivial feature.

**Per-feature plans to write:**

- `dome-hooks-v1-phase-1a-dailies-bundle.md` — bundle skeleton + page type + preamble
- `dome-hooks-v1-phase-1b-daily-creator-hook.md` — clock-tick + template
- `dome-hooks-v1-phase-1c-task-carry-forward.md` — Obsidian Tasks syntax parser + carry-forward workflow
- `dome-hooks-v1-phase-1d-weekly-creator-hook.md` — weekly with this-week + last-week context
- `dome-hooks-v1-phase-1e-dailies-migration.md` — `dome migrate-dailies notes/ → wiki/dailies/`

### Deliverable

Directory `.dome/extensions/dailies/` containing:

```
manifest.yaml          # name: dailies, version: 1.0.0, deps: []
page-types.yaml        # daily → wiki/dailies/ + frontmatter schema
preamble.md            # how dailies work; agent conventions
workflows/
  create-daily.md      # template-instantiation workflow
  create-weekly.md     # weekly with last-week context
  carry-forward-tasks.md
hooks/
  create-daily.yaml    # schedule: "0 6 * * *", workflow: create-daily
  create-weekly.yaml   # schedule: "0 6 * * 1", workflow: create-weekly
```

Plus a one-shot CLI: `dome migrate-dailies` moves files from `notes/` (or `raw/daily/`) to `wiki/dailies/` and rewrites frontmatter/links.

### Dependencies

- Phase 0a (bundle loader)
- Phase 0b (preamble fragments)
- Phase 0c (`schedule:` field)
- Phase 0e (`dome run-hook` — useful for `run-hook create-daily` during dev)

### Substrate changes

- Daily page type schema lives in the bundle, not in core `page-type.ts`. This is the substrate-extension proof case.
- A new gotcha in the bundle's `docs/`: `tasks-plugin-syntax-respected` — the carry-forward workflow must parse Obsidian Tasks syntax exactly (priority emojis, ✅ completion dates, recurrence markers); custom syntax breaks existing user-authored content.

### Open decisions (gate before execution)

1. **Carry-forward semantics.** Copy-with-backref (recommended in brainstorm) vs. move. Decide before 1c.
2. **Daily template content.** Lift from `~/vaults/work/templates/Daily Note.md` or reauthor? Recommend: lift, adapt frontmatter to Dome wikilink format.
3. **Weekly bundle membership.** Same bundle as dailies, or separate `weeklies` bundle? Recommend: same bundle (tight coupling — weekly reads dailies).
4. **Migration path** for the existing `notes/<YYYY-MM-DD>.md` files. `dome migrate-dailies` rewrites filenames + frontmatter + wikilinks pointing at the old paths. Run once; not idempotent on already-migrated vaults (detects + no-ops).

### Acceptance signal

For three consecutive days, `wiki/dailies/<date>.md` is created automatically at 6am with the right template and previous-day open tasks carried forward; AGENTS.md contains the dailies preamble; opening Obsidian shows wikilinks resolve correctly; the migrated `notes/` files no longer exist.

---

## Phase 2 — compile-on-write keystone (L2)

**Goal:** Edits to a daily note propagate to entity pages, concept pages, the task index, and meeting threads. The wiki stays close to coherent without manual rewiring.

**Per-feature plans to write:**

- `dome-hooks-v1-phase-2a-task-index.md` — L2.3, cheap deterministic, ships first
- `dome-hooks-v1-phase-2b-entity-concept-propagation.md` — L2.1 + L2.2 together (same shape)
- `dome-hooks-v1-phase-2c-meeting-outcomes.md` — L2.4
- `dome-hooks-v1-phase-2d-explicit-followups.md` — L2.5 (optional, lower priority)
- `dome-hooks-v1-phase-2e-debounce-cost-discipline.md` — G6 supporting work

### Pipeline shape

One hook (`compile-daily`) subscribes to `document.written.dailies.*`. Pipeline order matters for cost:

```
on document.written.dailies.<date>:
  1. Diff against prior version (cheap, deterministic)
  2. Cheap extractors (no LLM):
     - Wikilinks added/removed     → list of touched entities + concepts
     - Task line changes (Obsidian Tasks syntax) → task transitions
     - Meeting section edits       → list of touched meeting threads
  3. Run L2.3 immediately (tasks index update — no LLM)
  4. Decide LLM scope per touched target:
     - Structural change only → upsertSection with "mentioned in [[date]]"
     - Narrative change → enqueue LLM extractor for that target
  5. LLM extractors run, serialized per-target (multiple paragraphs about Danny → one update job, not N)
  6. All writes via upsertSection (G5) — idempotency by construction
```

### Compile trigger timing

Default: **async-debounced 30s after last save.** Manual override via `dome compile-daily <date>` (uses Phase 0e's `run-hook`).

Reasoning: cheap-then-expensive within the hook means the deterministic parts (task index, wikilink propagation) run instantly; LLM calls only happen for narrative diffs. Manual trigger handles the "I just dumped a paragraph and want the wiki updated NOW" case.

This is a **gate decision** from the brainstorm; reconfirm before executing 2b.

### Dependencies

- Phase 1 (the `dailies` page type must exist before this hook can subscribe)
- Phase 0d (`upsertSection` — used everywhere in L2.1/L2.2/L2.4)
- Phase 0e (`run-hook` — Phase 2's manual-trigger story)

### Substrate changes

- `docs/wiki/specs/hooks.md` "Adding a new hook" recipe gains an LLM-extractor example.
- New gotcha: `llm-extractor-cost-discipline` — narrative-extractor hooks must use cheap-then-expensive pipeline + per-target serialization + content-addressed upsert; the eval suite is the lockstep.
- New gotcha: `tasks-index-staleness-window` — L2.3 task index is debounced 30s, so it lags edits by that window; agents querying tasks should accept the lag or invoke compile-daily synchronously.

### Eval suite work

Every LLM extractor (L2.1, L2.2, L2.4) gets a golden-snapshot eval test:
- Fixture vault → fixture daily edit → expected wiki updates.
- Real-LLM run in eval suite (slow, gated on CI label).
- Mocked-LLM run in unit suite (fast, default CI).

### Acceptance signal

- Mark writes "Met with Danny about Open Eng Staff" in today's daily; within 30s the Danny entity page has an upserted "Recent context — 2026-05-26" section summarizing the meeting; the Open Eng Staff concept page has an upserted "Recent positions" entry; the task index updates if there's a new task line; everything is idempotent on a second save.
- Re-running `dome compile-daily 2026-05-26` after manual edits to Danny's page does not duplicate the section (upsert is content-addressed).

---

## Phase 3 — aggregation & reflection (L3)

**Goal:** Cadenced reflection. Weekly review on Sundays; monthly retro on the 1st; stale-thread surface weekly.

**Per-feature plans to write:**

- `dome-hooks-v1-phase-3a-weekly-rollup.md` — L3.1
- `dome-hooks-v1-phase-3b-monthly-retrospective.md` — L3.2
- `dome-hooks-v1-phase-3c-stale-thread-surface.md` — L3.3

### Deliverables

A new extension bundle `aggregation` (separate from `dailies` — independent lifecycle, easier to dogfood/disable independently):

```
.dome/extensions/aggregation/
  manifest.yaml
  preamble.md
  workflows/
    weekly-rollup.md
    monthly-retro.md
    surface-stale-threads.md
  hooks/
    weekly-rollup.yaml      # schedule: "0 18 * * 0"
    monthly-retro.yaml      # schedule: "0 18 1 * *"
    stale-threads.yaml      # schedule: "0 18 * * 0"
```

**L3.1 weekly rollup.** Reads `wiki/dailies/<week>/*.md`; drafts `wiki/weeklies/<YYYY-W##>-review.md` with: completed tasks, key threads moved, decisions made, person interactions, suggested focus for next week. User edits.

**L3.2 monthly retrospective.** Reads `wiki/weeklies/<month>/*.md`; drafts `wiki/monthlies/<YYYY-MM>-retro.md`. No new `clock.tick.monthly` needed — `schedule: "0 18 1 * *"` (Phase 0c) handles it.

**L3.3 stale-thread surface.** Scans `wiki/entities/*.md` and `wiki/concepts/*.md` by `last_interaction` frontmatter (which Phase 2's L2.1/L2.2 maintain). Surfaces stale-with-open-commitments to `wiki/syntheses/stale-threads.md`.

### Dependencies

- Phase 1 (dailies + weeklies exist)
- Phase 2's L2.1 + L2.2 (provides `last_interaction` frontmatter)

### Acceptance signal

A Sunday-evening run produces a useful weekly-review draft from that week's dailies, with sections that match what Mark would have written manually; the stale-thread index surfaces 3-5 people/threads not touched in N weeks.

---

## Phase 4 — recall workflows (parallel-startable)

**Goal:** Ship the agent-facing recall surfaces. Pure LLM workflows; no new hook plumbing. Can dogfood early against the *current* `~/vaults/work/notes/` vault (reduced fidelity) before Phase 1 lands; sharpens once Phases 1-3 produce structured outputs.

**Per-feature plans to write:**

- `dome-hooks-v1-phase-4a-plan-today.md` — L4.1
- `dome-hooks-v1-phase-4b-follow-up-with.md` — L4.2
- `dome-hooks-v1-phase-4c-retro-recall.md` — L4.3

### Deliverables

A new extension bundle `recall` (or part of `dailies` — TBD):

```
.dome/extensions/recall/
  manifest.yaml
  workflows/
    plan-today.md
    follow-up-with.md
    retro-recall.md
```

These ship as workflows accessible via:
- `dome plan-today` (new CLI command)
- `dome follow-up-with <name>`
- `dome retro --month <month>`

Plus the agent can invoke them directly (they appear in `AbstractSurface.workflows`).

### Dependencies

None strictly required. Sharpens with Phases 1-3:
- Without Phase 1: reads `~/vaults/work/notes/` directly (loose).
- Without Phase 2: no `last_interaction` frontmatter; falls back to grep-style mention scanning.
- Without Phase 3: no monthly retro pre-aggregation; L4.3 reads dailies/weeklies directly (more LLM cost).

### Acceptance signal

`dome plan-today` produces a useful morning agenda from today's daily + tasks-index + recent context. `dome follow-up-with danny` lists open follow-ups + recent mentions. These are subjective acceptance criteria; dogfood iteration will sharpen the workflow prompts.

---

## Cross-cutting concerns

### Eval suite

Every LLM-touching feature (Phase 2 all of it; Phase 3 all of it; Phase 4 all of it) needs eval-suite coverage. Existing eval suite at `src/eval/` (per substrate report) — extend it per phase.

**Test shape:** golden-vault fixtures → known input → expected output. Real-LLM run on CI label; mocked default.

**Cost discipline:** eval runs are slow + expensive. Gate behind explicit label; not on every PR.

### Migration story

Phase 1 includes `dome migrate-dailies`. Worth thinking about: do *other* extensions need migration helpers? Likely not in v1 — each bundle owns its migration if needed. Convention worth documenting in the `sdk-surface.md` "Adding a new extension bundle" recipe: bundle-owned migrations live in `<bundle>/migrations/`.

### Workflow-author UX

The brainstorm flagged that workflows live in markdown prose. Phase 1+ will produce a lot of workflow files. Worth ensuring the `PromptLoader` substrate (refactor F4) handles bundle-contributed workflows cleanly — they should resolve from `.dome/extensions/<name>/workflows/` alongside `.dome/prompts/`.

This may surface a small gap in the refactor's F4: does `WorkflowRegistry` know about bundle-contributed workflows, or only `.dome/prompts/`? Check during Phase 0a.

### Plugin ecosystem (post-v1)

This roadmap deliberately does NOT make the bundle loader externally distributable (no npm, no `dome install <plugin>`). All bundles are vault-local in `.dome/extensions/`. Plugin distribution is a v1.1+ concern. The work in this roadmap proves the bundle *contract* is right; external distribution becomes a packaging concern, not a substrate concern.

---

## Decisions to land before executing each phase

Reproduced from the brainstorm for traceability. Each is a gate.

| Decision | Phase gate | Recommendation |
|---|---|---|
| Compile-on-write trigger timing | Phase 2 | Async-debounced 30s + manual override |
| Carry-forward semantics for tasks | Phase 1c | Copy-with-backref |
| Bundle split (dailies / aggregation / recall) | Phase 1a, 3a, 4a | Split by lifecycle |
| Migration vs. category-add for existing `notes/` | Phase 1e | Migrate to `wiki/dailies/` |
| Where LLM call runs (workflow registry vs. abstraction) | Phase 2 | Workflow registry path |

---

## Cross-references

- Product brainstorm: `docs/cohesive/brainstorms/2026-05-26-dome-hooks-v1-roadmap.md`
- v0.5-to-v1 refactor delta ledger: `docs/cohesive/delta-ledgers/2026-05-26-dome-v0.5-to-v1-tightening.md`
- Multi-vault session shape brainstorm: TBD (deferred from refactor's F8)
- Pattern recipes added by the refactor (use as templates for Phase 0 substrate work):
  - `docs/wiki/specs/sdk-surface.md` §"Adding a new invariant"
  - `docs/wiki/specs/cli.md` §"Adding a new command"
  - `docs/wiki/specs/hooks.md` §"Adding a new hook"

---

## What to do next

1. Land the refactor (out of scope for this plan).
2. Write the Phase 0a plan (`dome-hooks-v1-phase-0a-extension-bundle-loader.md`) as the first concrete per-feature plan.
3. Execute Phase 0 in parallel where possible (0a + 0c + 0d + 0e can all run concurrently; 0b depends on 0a).
4. Reconfirm the open decisions for Phase 1 before moving on.
5. Write Phase 1 per-feature plans; execute sequentially within Phase 1 (carry-forward depends on creator hook depends on bundle skeleton).
6. Branch Phase 2 + Phase 4-reduced-scope work concurrently if there's bandwidth.
7. Tighten Phase 3 and Phase 4-full-fidelity after Phase 2 lands.
