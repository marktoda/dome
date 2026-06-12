# Dome v1 Chunk 7 — Laptop-First Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the laptop a first-class daemon host: the wake-tick missed-cron burst composes a correct morning (brief doesn't race the calendar/slack fetches), and phone capture becomes eventually consistent via an iCloud-Drive queue drained laptop-side.

**Architecture:** Two independent halves. **(A) Wake choreography:** when multiple missed crons fire in one tick, the brief can run before the async calendar/slack fetch lands (outbox → command → commit → adoption takes minutes). Fix at the consumer: the brief gains file-created signal triggers on `sources/calendar/*.md` + `sources/slack/*.md` and an internal idempotence gate — if today's daily already carries a brief that was composed WITH the now-present sources, no-op; if the brief ran sourceless and a today-source has since landed, re-compose (bounded: at most one re-run per source arrival, ~$0.25). Also verify (and fix if false) that same-tick missed crons fire in cron-time order. **(B) Eventually-consistent capture:** the `dome recipe ios` Shortcut gains a try-POST-then-queue fallback (save the dictated text as `<ISO-timestamp>-<uuid>.md` into iCloud Drive `DomeCaptures/`); a new `assets/source-handlers/drain-captures.sh` sweeps a configured queue directory into capture files (one inbox/raw file per queued item, filename → captureId idempotency, delete-on-committed-success), wired as a dome.sources subscription so it rides the existing consent-gated 15-minute machinery — BUT the subscription contract is one-output-file-per-period (skip-if-present), which a many-files drain violates; the executor verifies the contract and either (a) uses the documented external-job pattern (launchd plist printed by a new `dome recipe capture-queue`, mirroring the manual dome-http unit precedent) or (b) extends the subscription contract minimally if the spec allows a no-output_path action kind — pick honestly, record the choice.

**Verified context flags:** (a) scheduler same-tick ordering (`src/engine/operational/scheduler.ts` — do multiple due processors fire in cron order?); (b) brief's existing triggers + the splice/no-op machinery from the failure-recovery work; (c) the sources subscription contract's output_path semantics (`docs/wiki/specs/sources.md`, fetch.ts skip-if-present); (d) `dome capture` has a `--file` flag? (check) — the drain wants `dome capture` semantics (raw file + commit) without reimplementing them; (e) recipe test conventions.

## Tasks

### Task 1: wake-tick choreography
- Verify scheduler same-tick ordering empirically (test with three due crons); fix to cron-time order if unordered (small, deterministic).
- Brief: add `file.created` signal triggers on `sources/calendar/*.md` + `sources/slack/*.md` (manifest, singular pathPattern); internal gate: track which today-sources the last composition saw (deterministic — e.g. the daily's brief block records a sources line, or derive from the spliced content); signal fire with no NEW today-source → zero effects (cheap, no model call); new today-source after a sourceless compose → re-compose. Cap: at most one re-run per source kind per day (idempotency key or ledger-free derivation — keep it deterministic). TDD: sourceless brief → calendar lands → signal → recomposed with meetings; second signal → no-op; cost-free no-op path pinned (no model.invoke on the no-op).
- Commit per logical piece.

### Task 2: eventually-consistent capture
- `dome recipe ios`: the Shortcut steps gain the failure branch (If POST fails → Save File to iCloud Drive/DomeCaptures with timestamp-uuid filename). Update tests.
- Drain: per the architecture's honest-choice instruction — ship `assets/source-handlers/drain-captures.sh` (sweep `$1`=queue-dir args or env; for each file: `dome capture --file` or equivalent → on committed success, delete the queue file; idempotent via captureId=filename; exit 0 when queue empty) + the chosen wiring (subscription extension OR `dome recipe capture-queue` printing the launchd plist + install steps). Tests: template sh -n + content; drain behavior against a temp vault + temp queue dir (real `dome capture` invocation).
- Commit per piece.

### Task 3: specs + runbook + verify + merge
- Spec lockstep: capture.md (queue fallback recipe + drain), sources.md if the contract changed, cli.md (recipe kinds/sections), daily-surface.md (wake-tick choreography note + brief re-compose semantics), autonomous-agents.md (brief triggers/gate).
- Runbook laptop-first §2 gets the concrete drain setup steps.
- Full suite + typecheck; e2e smoke (queue file → drain → inbox/raw + commit; brief signal no-op path); final review; `--no-ff` merge.
