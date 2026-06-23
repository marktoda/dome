---
type: brainstorm
tags: [design, dome.markdown, dome.agent, duplicate-detection, consolidate, adoption, performance]
created: 2026-06-16
status: approved-design
---

# Retire `dome.markdown.duplicate-detection` (superseded by `dome.agent.consolidate`)

Approved 2026-06-16 (owner: "retire it"). Emerged from a live diagnosis: a work-vault
capture was stranded because `dome.markdown.duplicate-detection` — an **adoption-phase**
processor that reads + parses **every** markdown page each run — exceeds its 30s timeout
on a 797-page vault. Adoption-phase timeouts are **block-severity**, so it was silently
blocking every wiki-touching adoption (including the capture-lift sub-proposal), not just
slowing things down.

## Why retire rather than optimize

`dome.markdown.duplicate-detection` (+ its partner `dome.markdown.duplicate-detection-answer`)
is **superseded by `dome.agent.consolidate`**:

| | duplicate-detection | consolidate |
|---|---|---|
| Detects | exact normalized-title + identical first prose paragraph | near-duplicates by LLM judgment (titles/slugs/descriptions/topic) — a **superset** |
| Acts | emits a **question**; on "merge" the answer processor writes a review *scaffold* (never merges) | **losslessly merges** into one canonical page (or asks when unsure) |
| Targets | any changed comparable page | "newly ingested pages (fresh ingest is where new duplicates are born)" — the **exact case** dup-detection guards |
| Phase / cost | adoption-phase; **O(all pages)** read every run; **blocks adoption** on timeout | nightly garden agent; bounded (`MAX_CHANGED_FILES`); scoped to recent drift |

Consolidate catches strictly more, actually merges (dup-detection only asks + scaffolds),
already targets fresh-ingest duplicates, and does NOT block adoption. Duplicate-detection's
only unique properties — prompt (write-time) flagging and no LLM cost — are not worth
**blocking the entire engine** on a large vault for a conservative question channel whose
job consolidate does better. Optimizing it (e.g. a title→pages index projection) would
polish a processor that overlaps a more capable one. Retiring it is both the performance
fix and a simplification — collapsing dedup onto the one powerful flow (`consolidate`).

## Scope: what gets removed

**Delete (3 files):**
- `assets/extensions/dome.markdown/processors/duplicate-detection.ts`
- `assets/extensions/dome.markdown/processors/duplicate-detection-answer.ts`
- `assets/extensions/dome.markdown/processors/duplicate-detection-shared.ts`

**Manifest** (`assets/extensions/dome.markdown/manifest.yaml`): remove the two processor
entries (`duplicate-detection` adoption + `duplicate-detection-answer` garden).

**Maintenance-loops registry** (`src/extensions/maintenance-loops.ts`): remove both ids from
the `dome.markdown.hygiene` loop's `processors` list (~397-398) and `duplicate-detection-answer`
from `dome.question.continuity` (~502). The loop's dedup `settlement.key` ("duplicate page-pair")
and the "Duplicate consolidation must preserve source material" risk stay valid — they are now
satisfied by `dome.agent.consolidate` (already a member of the same loop); reword to attribute
dedup to consolidate rather than dropping the guarantee.

**Comments only (cosmetic, update the example)**: `src/engine/host/health.ts:63`,
`src/processors/execution-policy.ts:33`, `assets/extensions/dome.claims/manifest.yaml:82` —
each mentions duplicate-detection as a "slow adoption scan / 30s timeout" example. Repoint to a
surviving example (e.g. `dome.markdown.lint-supersession`, still a 30s scan) or generalize.

**Tests:**
- DELETE `tests/harness/scenarios/effect-kinds/duplicate-detection-questions.scenario.test.ts`.
- RETARGET (don't just delete) tests that used dup-detection as a convenient real subject:
  `tests/harness/scenarios/cli-surface/answer-question.scenario.test.ts` (uses the dup question as
  the answer-flow example), `tests/harness/scenarios/cli-surface/doctor-health.scenario.test.ts`,
  `tests/engine/health-recurring-failures.test.ts` (recurring-timeout subject),
  `tests/processors/execution-policy.test.ts`, `tests/processors/execution-state-prune.test.ts`.
  Substitute another real adoption-phase question/timeout processor (e.g.
  `dome.markdown.ambiguous-wikilink-answer` for the answer flow, `dome.markdown.lint-supersession`
  for a slow scan) — pick per test, keep the assertion's intent.
- UPDATE lockstep/count assertions: `tests/extensions/loader.test.ts`,
  `tests/harness/meta/coverage-matrix.test.ts`.
- The fixture bundles `test.answer-handler` / `test.page-type-job-flow` only reuse the literal
  `idempotencyKeyPrefix: "dome.markdown.duplicate-detection:"` string — repoint to a neutral
  fixture prefix so they don't reference a deleted processor (functionally inert either way).

**Docs / matrices / specs:** update the normative surfaces —
`docs/wiki/matrices/built-in-extensions-x-phase.md`, `docs/wiki/matrices/extension-bundle-shape.md`,
`docs/wiki/specs/processors.md`, `docs/wiki/specs/capabilities.md`,
`docs/wiki/specs/processor-execution.md`, `docs/wiki/specs/sdk-surface.md`, `docs/v1.md` — to drop
duplicate-detection from the built-in processor inventory and note consolidate owns dedup. Leave
**historical** docs (reviews, runbooks, dated plans under `docs/cohesive/reviews|runbooks` and
`docs/superpowers/plans`) untouched — they record what was true then (per the keep-owned-prose-current rule).

## Out of scope / non-goals

- No change to `consolidate` itself — it already does dedup; this only removes the redundant
  adoption-phase detector.
- The general "duplicate-detection perf" backlog item is **closed by removal**, not optimization.
- The work-vault's open `dome.markdown.duplicate-detection` questions + any half-written review
  scaffolds are an **operational cleanup** on the live vault (resolve/dismiss after the code ships
  + daemon restart), tracked separately from this code change.

## Testing

1. **Removal is clean:** `grep -r duplicate-detection` over `src/` + `assets/` + non-historical
   `docs/` returns only intentional consolidate-attribution mentions; `bunx tsc --noEmit` adds no
   errors; the manifest loader test passes with the two processors gone.
2. **Maintenance-loops lockstep** green (the loop-membership ↔ registered-processors check).
3. **Retargeted tests** still assert their original intent against the substitute processor.
4. **Full suite** green (watch the lockstep matrices, loader, coverage-matrix, and the retargeted
   scenarios).
5. **Adoption no longer blocks on a whole-vault dedup scan** — confirmed by the absence of the
   `processor.timeout: dome.markdown.duplicate-detection` block once the daemon runs the new code.
