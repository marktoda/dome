# Dome V1 Implementation Audit

**Date:** 2026-06-02
**Subject:** Current implementation evidence against `docs/v1.md`
**Verdict:** Implementation is close; V1 is not yet fully done because real
work-vault soak criteria remain unproven.

## Executive Judgment

The architecture now matches the V1 design direction: Dome remains a compiler
over markdown and git, processors remain the executable unit, effects remain
the only processor output, and maintenance loops are metadata/status over
existing processors rather than a hidden workflow engine.

The strongest implemented slices are the five maintenance loops:

- capture digestion,
- open-loop continuity,
- link and concept coherence,
- context packets,
- question continuity.

The highest-risk remaining gap is not a missing engine primitive. It is product
proof: the M10 release soak still needs enough real work-vault usage to show
that daily notes, context packets, capture digestion, and low-risk question
resolution improve Mark's day-to-day workflow without creating chore work.

## Current Evidence

Recent local verification:

- `bun run v1:check` passed end-to-end after the latest snapshot-script
  coverage pass:
  `bun run typecheck`, `git diff --check`, `bun test`, and `bun run v1:smoke`.
- The full Bun suite passed with `998 pass`, `0 fail`, and `21381`
  assertions.
- `v1-smoke` checked both the docs vault and work vault. Docs was clean at
  head/adopted `7be6cf7`; work was clean at head/adopted `99fac73`.
- The smoke confirmed settled sync behavior on both vaults: clean already
  adopted vaults return `status: in-sync`, `iterations: 0`,
  `closureCommit: null`, and no garden sub-Proposals, rejected patches, or
  operational diagnostics.

Current top-level acceptance coverage:

- `tests/harness/scenarios/v1-acceptance/claude-code-vault-loop.scenario.test.ts`
  exercises the combined V1 path: committed markdown, adoption, garden
  processors, capture digestion, source-backed facts, question surfacing,
  daily views, query, export-context, resolve, and doctor.

## Milestone Audit

### M0 - Design Reset

**Status:** Implemented.

Evidence:

- `docs/v1.md` is the plan of record and frames V1 around source-preserving
  convergent maintenance loops.
- `docs/index.md` points at `[[v1]]` using the new framing.
- The active design distinguishes processors, bundles, loops, and surfaces.

Residual risk:

- Historical V1/v0.5 docs remain under `docs/cohesive/` and
  `docs/superpowers/`, but they are not the active plan of record.

### M1 - Loop Substrate and Status Vocabulary

**Status:** Implemented and test-backed.

Evidence:

- `src/extensions/maintenance-loops.ts` defines the five first-party V1 loops
  with ids, goals, evidence, processors, surfaces, settlement rules, and risks.
- `src/cli/maintenance-loop-summary.ts` derives loop status from active
  processors, diagnostics, questions, and runs without adding a loop executor.
- `src/cli/commands/status.ts` exposes `maintenance_loops` in JSON status.
- `tests/extensions/maintenance-loops.test.ts` validates loop metadata, stale
  processor references, invalid surfaces, optional processors, duplicate
  references, and public command surface names.

Residual risk:

- Loop metadata is adjacent first-party registry data, not bundle-local
  manifest metadata. That is intentional for V1, but future third-party loop
  authoring should revisit bundle-local declarations.

### M2 - Work-Vault Dogfood Baseline

**Status:** Mostly implemented; dogfood proof remains partial.

Evidence:

- `dome init --with-model-provider anthropic` is implemented and tested in
  `tests/cli/commands.test.ts`.
- Command model provider behavior is tested in
  `tests/engine/command-model-provider.test.ts`.
- `src/cli/commands/status.ts` detects waiting raw captures when the capture
  loop is inactive, partial, or enabled without a model provider.
- `tests/cli/commands.test.ts` covers `capture_loop_inactive` for disabled
  intake and missing-provider intake.
- `tests/cli/serve.test.ts` covers long-running `serve` picking up config and
  model-provider changes.

Unproven:

- Full work-vault baseline classification over real accumulated diagnostics is
  not captured in a durable dogfood ledger.
- At least one real capture was smoked with Anthropic during implementation,
  but that is not the same as a sustained baseline.

### M3 - Capture Digestion Loop

**Status:** Implemented and strongly test-backed; real-week proof remains open.

Evidence:

- `assets/extensions/dome.intake/processors/extract-capture.ts` digests raw
  captures into generated pages and processed archives with source hashes.
- `assets/extensions/dome.intake/processors/capture-index.ts` rebuilds
  confidence-carrying facts and low-confidence questions from generated
  markdown.
- `assets/extensions/dome.intake/processors/synthesize-capture.ts` and
  `synthesize-rollup.ts` write source-linked synthesis pages with input hashes.
- `tests/harness/scenarios/effect-kinds/intake-extract-capture.scenario.test.ts`
  covers initial extraction, no-op behavior, later enablement, pending capture
  scans, low-confidence questions, rebuildability, and source preservation.

Unproven:

- `docs/v1.md` asks for at least one real work-vault week of captures without
  lost raw material. That needs elapsed dogfood evidence.

### M4 - Open-Loop Continuity and Daily Surface

**Status:** Implemented and test-backed.

Evidence:

- `assets/extensions/dome.daily/processors/create-daily.ts` creates the V1
  daily shape.
- `assets/extensions/dome.daily/processors/carry-forward.ts` maintains small
  generated `## Start Here` and `## Open Loops` sections.
- `assets/extensions/dome.daily/processors/task-index.ts` indexes user-authored
  tasks/followups while ignoring generated daily blocks, frontmatter, and
  blockquoted evidence.
- `tests/harness/scenarios/effect-routing/daily-create-carry-forward.scenario.test.ts`
  covers daily creation, raising backlog open loops, and resolved/dismissed
  generated rows staying settled.
- `tests/harness/scenarios/effect-kinds/daily-task-index-facts.scenario.test.ts`
  covers stable open-loop SourceRef identity and no duplicate generated facts.

Residual risk:

- Daily usefulness is partly subjective and still needs work-vault soak.

### M5 - Link and Concept Coherence

**Status:** Implemented and test-backed.

Evidence:

- `assets/extensions/dome.markdown/processors/validate-wikilinks.ts` validates
  links, asks source-backed ambiguous-link questions, and classifies lower-risk
  broken links as diagnostics.
- `assets/extensions/dome.markdown/processors/repair-wikilinks.ts` performs
  conservative high-confidence repairs and source-backed concept/entity stubs.
- `assets/extensions/dome.markdown/processors/ambiguous-wikilink-answer.ts`
  applies answered repairs through normal garden patches.
- `assets/extensions/dome.markdown/processors/duplicate-detection.ts` and
  `duplicate-detection-answer.ts` preserve duplicate sources through
  deterministic duplicate-review synthesis pages.
- `assets/extensions/dome.markdown/processors/simplify-indexes.ts` maintains
  small generated index blocks.
- Coverage lives in `tests/extensions/validate-wikilinks.test.ts`,
  `tests/extensions/repair-wikilinks.test.ts`,
  `tests/harness/scenarios/effect-kinds/wikilink-ambiguity-questions.scenario.test.ts`,
  and `tests/harness/scenarios/effect-kinds/duplicate-detection-questions.scenario.test.ts`.

Residual risk:

- Precision should keep being watched in the work vault, especially around
  ambiguous links and stub creation.

### M6 - Context Packet Loop

**Status:** Implemented and test-backed; real-session usefulness remains open.

Evidence:

- `assets/extensions/dome.search/processors/query.ts` and
  `export-context.ts` share expanded FTS plus graph/page-type/open-loop/
  decision/question/diagnostic/projection recall signals.
- `docs/wiki/specs/cli.md` documents ranking reasons, recall signals, source
  refs, unresolved questions, and concise source-backed packet summaries.
- `tests/harness/scenarios/cli-surface/query-adopted-state.scenario.test.ts`
  covers query recall from related facts.
- `tests/harness/scenarios/cli-surface/export-context.scenario.test.ts`
  covers source-backed context packets.
- `tests/harness/scenarios/v1-acceptance/claude-code-vault-loop.scenario.test.ts`
  verifies a foreground-agent style packet over capture-derived context.

Unproven:

- `docs/v1.md` asks for real cases where packet quality improved an agent
  session. This needs dogfood examples, not just tests.

### M7 - Question Continuity and Agent-Safe Resolution

**Status:** Implemented and test-backed.

Evidence:

- `src/projections/questions.ts` stores metadata including risk, confidence,
  recommended answer, automation policy, owner-needed reason, source refs, and
  answer history.
- `src/engine/question-auto-resolution.ts` implements opt-in background
  auto-resolution for low-risk source-backed questions.
- `src/engine/question-answering.ts` and `src/answers/question-answers.ts`
  route answers through durable recording and garden answer handlers.
- Answer handlers exist for health recovery, ambiguous wikilinks, ambiguous
  followups, and low-confidence intake candidates.
- `tests/harness/scenarios/cli-surface/answer-question.scenario.test.ts` and
  `tests/cli/commands.test.ts` cover resolve behavior and metadata separation.

Residual risk:

- The policy is conservative. That is right for V1 safety, but dogfood should
  measure whether owner-needed questions are still too frequent.

### M8 - Recall and Search Quality

**Status:** Implemented except embeddings, which are explicitly deferred.

Evidence:

- `query` and `export-context` ranking are implemented in the `dome.search`
  processors and documented in `docs/wiki/specs/cli.md`.
- Projection-signal recall is shared by query/context packet paths.
- `dome inspect facts` and `dome inspect patches` are implemented in
  `src/cli/commands/inspect.ts` and tested in `tests/cli/commands.test.ts`.
- `scripts/v1-smoke.ts` now verifies that work-vault query and context packet
  results include source refs, rank the current daily surface first for daily
  intent, and emit non-empty summaries.
- `docs/v1.md` decision ledger explicitly defers embeddings to V1.1 unless
  concrete work-vault failures prove they are needed.

Unproven:

- The embeddings deferral needs work-vault evidence if search/context misses
  become a real problem.

### M9 - Extension Hardening

**Status:** Implemented for first-party V1 extension shape.

Evidence:

- Bundle loading and manifest validation are covered by
  `tests/extensions/loader.test.ts`, `tests/integration/default-vault-config.test.ts`,
  and `tests/integration/bundle-matrix-lockstep.test.ts`.
- Active bundle ids now fail loudly when the configured bundle is absent from
  the selected roots. This prevents enabled processors from being silently
  skipped in exact bundle-root mode.
- Loop metadata validation is covered by
  `tests/extensions/maintenance-loops.test.ts`.
- Public view command aliases are centralized in `src/cli/view-command-aliases.ts`
  so loop surfaces expose public CLI names rather than internal trigger names.
- Authoring guidance is documented in `docs/wiki/specs/processors.md` and
  `docs/wiki/specs/sdk-surface.md`.

Residual risk:

- Broad grants are visible and intentional for first-party bundles, but V1
  does not yet provide a public third-party maintenance-loop packaging story.

### M10 - V1 Release Soak

**Status:** Not complete.

Evidence:

- The code has been smoked against `docs/` and `~/vaults/work`.
- The harness suite covers the core behavior expected from the soak.
- `docs/cohesive/reviews/2026-06-02-v1-work-vault-dogfood-ledger.md` starts
  the durable work-vault dogfood record with a 2026-06-02 baseline.
- `scripts/v1-smoke.ts` now includes a settled-sync assertion for clean,
  already-adopted docs/work vaults.

Missing:

- Two real work weeks of continuous or near-continuous work-vault use.
- Continued daily notes on daily note usefulness, capture quality, open-loop
  surfacing, context packet quality, question burden, and high-friction fixes.
- Concrete examples where foreground agents used Dome context packets or query
  surfaces successfully in real work.

## Completion Assessment

Do not mark V1 complete yet.

The implementation has passed the main architecture test: loops are coherent
status/extension metadata over processors and effects, not a second runtime.
The remaining work is proving product usefulness and closing issues discovered
during that proof.

Recommended next steps:

1. Run one full post-audit verification pass: `bun test`, `bun run typecheck`,
   and `git diff --check`.
2. Smoke `~/vaults/work` with `sync`, `status`, `check`, `today`, `query`, and
   `export-context`.
3. Continue the M10 dogfood ledger with one entry per workday covering:
   daily note usefulness, capture digestion, surfaced open loops, packet/query
   quality, question burden, and any manual Claude Code maintenance Dome should
   have handled.
4. Treat any recurring dogfood miss as the next V1 engineering gap.

## 2026-06-02 Post-Audit Addendum

Additional verification after the first audit:

- Fixed and committed `d74542c Ignore transient Dome state in git status`.
  The bug was a real runtime/status race: `git.statusMatrix` could observe a
  transient `.dome/state/locks/*.compiler-host.lock` file and then throw ENOENT
  if the compiler-host lock disappeared before isomorphic-git statted it.
  `src/git.ts` now filters `.dome/state/**` at the git boundary while still
  keeping committed vault configuration such as `.dome/config.yaml` visible.
- Added regression coverage in `tests/git.test.ts` for both standalone vaults
  and nested-vault/dogfood mode.
- Raw `bun test` now passes with `992 pass`, `0 fail`.
- `bun run typecheck`, `git diff --check`, and `bun scripts/v1-smoke.ts
  --sync-docs` passed. The smoke synced the docs vault to `d74542c`; the work
  vault remained synced with no attention findings.

Current work-vault smoke evidence:

- `dome status --vault ~/vaults/work --json` steady state:
  `sync_needed: false`, no dirty files, no pending/failed runs, no open
  questions, no outbox/quarantine issues, and no attention.
- Maintenance loops:
  - `dome.capture.digest`: inactive because `dome.intake` is disabled in the
    work vault; there are currently no `inbox/raw` captures waiting.
  - `dome.open-loop.continuity`: quiet.
  - `dome.link-concept.coherence`: drift from 46 informational diagnostics
    only; no attention diagnostics.
  - `dome.context.packet`: quiet.
  - `dome.question.continuity`: quiet.
- `dome check --vault ~/vaults/work --json` reports engine status `ok`.
  The 46 content diagnostics are grouped into known repair paths:
  `link.resolve-or-create` and `frontmatter.repair`.
- `dome today --vault ~/vaults/work --json` finds
  `notes/2026-06-02.md`, reports 221 source-backed open tasks, samples both
  daily-surface rows and backlog rows, and has 0 questions.
- `dome query --vault ~/vaults/work "today open loops" --json` and
  `dome export-context --vault ~/vaults/work "today open loops" --json` both
  put `notes/2026-06-02.md` first via the `current daily surface` recall
  signal. The context packet overview now carries the current daily cockpit's
  open loops with SourceRefs to both the daily surface and backing sources.

Updated assessment:

- The implementation and verification gate are stronger than in the first
  audit. The main known flaky suite failure had a concrete root cause and is
  fixed at the correct abstraction boundary.
- V1 still should not be marked complete. The remaining gap is still M10:
  elapsed work-vault dogfood showing that daily notes, capture digestion,
  context packets, and low-risk question handling improve day-to-day work over
  plain markdown plus ad hoc foreground-agent maintenance.

## 2026-06-02 Gate Hardening Addendum

Latest verification:

- `bun test tests/harness/scenarios/effect-kinds/intake-extract-capture.scenario.test.ts`
  passed with `14 pass`, `0 fail`.
- `bun test tests/cli/bin.test.ts` passed with `2 pass`, `0 fail`.
- `bun run v1:check` passed end-to-end with `996 pass`, `0 fail` in the Bun
  suite, followed by successful docs/work V1 smoke.

Additional fixes from the latest gate:

- Several intake harness scenarios used `BASE_CONFIG`, which enables
  `dome.intake`, `dome.daily`, and `dome.markdown`, but only installed
  `dome.intake` in the fixture root. The stricter missing-bundle validation
  correctly exposed that mismatch. The scenarios now install the same bundles
  their config enables.
- The `bin/dome` process-boundary test for `serve` now has explicit process
  and test timeouts, so full-suite load cannot leave a child process hanging
  inside the readiness predicate.

## 2026-06-02 Dogfood Evidence Addendum

Additional M10 support:

- Added `bun run v1:dogfood-snapshot`, a read-only script that emits a
  ledger-ready Markdown snapshot from the work-vault `status`, `check`,
  `today`, `query`, and `export-context` surfaces.
- The script intentionally lives under `scripts/` rather than adding another
  product CLI command, preserving the V1 "small CLI, powerful compiler"
  constraint.
- The script now passes `--date` through to `dome today --date`, so a snapshot
  for a specific dogfood day measures the same daily surface it labels.
- `tests/scripts/v1-dogfood-snapshot.test.ts` covers help output and a
  disposable-vault end-to-end run through the real process boundary.
- A work-vault run on 2026-06-02 reported synced head/adopted `99fac73`, 0
  dirty files, 0 failed runs, 46 informational diagnostics, 0 questions, and
  the current daily surface as the top daily-intent context packet entry.

Updated assessment:

- This improves the quality and repeatability of M10 evidence collection.
- It still does not satisfy M10 by itself. The remaining release-readiness gap
  is elapsed work-vault usefulness across real work sessions.

## 2026-06-02 Networked LLM Smoke Addendum

Latest optional networked evidence:

- `bun run v1:llm-smoke` passed against a disposable vault using the
  scaffolded Anthropic command provider. It produced one generated intake page,
  one processed archive, settled with unchanged sync heads, reported 0
  diagnostics, and preserved 1 low-risk question.
- `bun run v1:llm-smoke -- --auto-resolve` also passed. It produced the same
  source-preserving capture outputs, settled with unchanged sync heads,
  reported 0 diagnostics and 0 questions, and auto-resolved 2 low-risk
  questions through normal answer handling.

Updated assessment:

- This strengthens M2/M3/M7 evidence for real model invocation, capture
  digestion, raw preservation, adopted-state recall, settlement, durable
  uncertainty, and opt-in low-risk auto-resolution.
- It still does not satisfy M10 because the smoke uses disposable fixtures, not
  sustained real work-vault usage.

## 2026-06-02 Dogfood Report Addendum

Additional M10 audit support:

- Added `bun run v1:dogfood-report`, an internal script that audits the
  work-vault dogfood ledger against the release-soak rubric without adding a
  new product CLI command.
- The report groups dated ledger sections, counts only workdays with both
  measured Dome surface output and filled qualitative notes for every M10
  dimension, separately tracks capture-evidence days, and requires complete
  workdays to span the two-work-week release-soak window.
- The parser is intentionally strict: generated snapshot prompts, controlled
  smoke prose, qualitative-only notes, partial qualitative notes, and short
  backfilled ledgers do not count as release-soak completion.
- Counted workdays now require explicit negative confirmations for lost or
  overwritten human markdown edits and manual `.dome/state` edits. Any
  non-negative answer is surfaced as a release blocker and keeps the report
  `not-ready`.
- `bun run v1:dogfood-report -- --require-ready` now exits nonzero unless the
  report is ready, giving M10 a mechanical final gate without making normal
  development checks fail while the release soak is still underway.
- `tests/scripts/v1-dogfood-report.test.ts` covers help output, complete versus
  partial workday detection, JSON output, default threshold behavior, and
  capture-evidence separation.

Current output:

- `bun run v1:dogfood-report` reports `Status: not-ready`,
  `Complete workdays: 0/10`, `Capture-evidence days: 0/5`, and
  `Complete-workday span: 0/12 calendar day(s)`.

Updated assessment:

- This makes the remaining M10 gate concrete and harder to overclaim.
- V1 still should not be marked complete. The evidence gate now correctly says
  the implementation is green, but elapsed work-vault usefulness is not yet
  proven.

## 2026-06-02 Dogfood Preflight Addendum

Additional M10 setup support:

- Added `bun run v1:dogfood-preflight`, a read-only internal script that checks
  whether a vault is ready to collect the next M10 dogfood session.
- The preflight combines `dome status`, `dome inspect bundles --model`, and the
  dogfood report. It separates session collection readiness from final
  release-soak readiness.
- Current work-vault result: operational readiness is clean, but capture
  readiness is `not-ready` because `dome.intake` is disabled, its processors
  are not loaded, and its model status is `disabled-provider-configured`.

Updated assessment:

- This makes the next M10 action concrete without mutating Mark's work vault:
  enable `dome.intake` intentionally before trying to collect capture-digestion
  evidence.
