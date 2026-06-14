# Dome v1 Chunk 11 — Operational Resilience (Half A: engine hardening) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Dome vault run clean without babysitting by closing the silent-failure classes a live-vault diagnostic (2026-06-13) found: a single bad question row aborting the whole operational tick (silently halting ALL auto-resolution), a heavy adoption processor silently wedging large vaults via timeout, recurring failures surfacing as growing identical question stacks instead of one root-cause finding, and retired-bundle/self-referential debris that never gets pruned. Ships SDK-wide; benefits every vault.

**No new bundle, no new primitive.** Engine hardening + dome.health detector additions over existing machinery.

**Grounding facts (from the diagnostic — verify each, cites are starting points):**
- Question metadata is validated `.strict()` on READ in `src/projections/questions.ts:190-206` (mirrors `src/core/effect.ts:608-631`); `queryQuestionRecords()` runs in the operational tick (`src/engine/operational/question-auto-resolution.ts:83`); a throw propagates uncaught to the tick boundary (`serve.ts` ~774 "tick threw") and aborts auto-resolution for the whole tick.
- `dome.markdown.duplicate-detection` has no `execution` block (`assets/extensions/dome.markdown/manifest.yaml:149`) → runs under the 10s adoption default → times out ~30+ times on the 786-page vault, producing `blocked main` ticks and ZERO health questions.
- `dome.health` (`assets/extensions/dome.health/`) is detect-and-ask only; six processors in three Q/A pairs (outbox/quarantine/orphan-run), all cron `* * * * *`. It models per-row failure, not recurring-failure loops, processor-timeout/adoption-block, or registry-orphan counters.
- `quarantined.json` retains a sub-threshold counter for `dome.intake.synthesize-rollup` — a bundle not registered anywhere — forever; `src/engine/host/health.ts:473-482` already filters orphan *runs* for unknown processors (the precedent to generalize); `src/processors/execution-state.ts:8,124-144` holds the quarantine threshold + snapshot gating.
- The orphan-run detector's OWN minute-cadence runs can themselves go orphan (self-referential pileup).

## Tasks

### Task 1 (HEADLINE): failure-isolating question rehydration + emit-time metadata validation
The deepest fix — one unreadable row must never halt all self-healing.
- (a) **Emit-time validation**: when a `QuestionEffect` is emitted/applied, validate its metadata against the same schema used on read, so a processor emitting an unmodeled key fails LOUDLY at its own effect (a diagnostic / rejected effect attributable to the emitter) instead of silently poisoning future reads. Find where QuestionEffects are validated on the write path (effect schema at emit, or the apply-effect/question-insert path) and add the metadata check there. Verify the read schema and the effect schema are the single source of truth (they're mirrored with a lockstep comment — keep that).
- (b) **Failure-isolating read**: `queryQuestionRecords()` (and any tick-path question read) must skip-and-log a row that fails rehydration rather than throw — one poison row drops itself (logged once, ideally surfaced as a diagnostic/health finding), the rest rehydrate, the tick completes, auto-resolution proceeds. Decide the skipped-row's fate: quarantine the row / mark it needs-attention so it's not silently lost.
- Tests: a row with an unknown metadata key (insert directly, simulating an older build) → the tick completes and OTHER questions still auto-resolve (the regression that bit prod); an emitter producing a bad key → fails at emit with an attributable diagnostic, not at later read. Verify against `tests/` patterns for questions + auto-resolution. This is the highest-value task; do it first and review hard.

### Task 2: adoption processor timeout (the silent wedge)
- Give `dome.markdown.duplicate-detection` a realistic `execution` timeout in its manifest (it's a heavy whole-vault adoption scan; the 10s default wedges large vaults). Pick a value consistent with how other heavy processors declare timeouts (read the manifest schema's execution block + any processor that sets one). Audit the other adoption processors for the same whole-vault-scan exposure (e.g. index-text, page-status, graph links) and give any that genuinely need it the same treatment — but ONLY where the scan is whole-vault and the default is demonstrably too tight; don't blanket-bump.
- A timeout is still a failure; ensure it's visible (feeds Task 3's recurring-failure detection rather than just a serve.log line).
- Tests: the manifest declares the timeout; a timeout still surfaces as the appropriate diagnostic. Update any lockstep/manifest test pins.

### Task 3: recurring-failure detection in dome.health
Turn "ask once per failed row, forever" into one root-cause-shaped finding.
- Add detection (generalize the existing health/recovery machinery) for: an outbox row that has failed its max attempts and KEEPS re-failing on re-emit (a fetch loop, not a transient) → one finding that says "X fails every run — the command/fetcher needs fixing," distinct from a retry-worthy transient; and a processor that repeatedly times out / blocks adoption → one finding ("processor Y exceeds its timeout repeatedly; raise its timeout or scope it"). Read how `dome.health` detectors + `src/engine/host/health.ts` findings work; prefer extending the findings surface (doctor/check) over spawning more minute-cadence questions, so this REDUCES the question pile rather than adding to it.
- Don't auto-remediate (preserve propose-not-auto); the win is a crisp actionable finding instead of silent serve.log noise + question stacks.
- Tests: a ledger/outbox fixture with a row failed N times → one recurring-failure finding (not N questions); a transient single failure → unchanged (still the normal retry question).

### Task 4: registry-orphan GC + self-referential orphan containment
- Prune execution-state counters (`quarantined.json` and kin) for processors whose bundle is no longer registered — generalize the `health.ts:473-482` orphan-run filter to the execution-state counters so retired-bundle dead weight gets GC'd (on load, or on a health tick). Verify it can't prune a legitimately-disabled-but-registered processor.
- Contain self-referential orphan growth: the health detectors' own minute-cadence runs shouldn't accumulate as orphan-run questions (mark them non-orphan-trackable, auto-fail their own stale rows, or exclude the recovery processors from orphan detection — pick the cleanest that doesn't blind real orphans).
- Tests: an execution-state counter for an unregistered bundle is pruned; a registered-but-disabled processor's counter survives; the orphan detector doesn't generate questions about its own runs.

### Task 5: verify + merge
Full `bun test` + `bun run typecheck`. Confirm no-accreting-registries / two-writer / invariant fences green. Final review (especially Task 1 correctness — the tick-isolation must genuinely not lose data, and emit-time validation must be attributable). Restart the work-vault daemon after merge so the fixes go live (Task 2's timeout + Task 1's isolation directly address its live debris). `--no-ff` merge.

Note: this is Half A. Half B (work-vault ops cleanup — calendar fetcher hardening, drain stale rows, launchd PATH, raw/-refire trace) is a separate pragmatic pass, not in this plan.
