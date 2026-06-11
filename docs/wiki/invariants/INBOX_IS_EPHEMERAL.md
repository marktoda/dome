---
type: invariant
created: 2026-05-27
updated: 2026-06-11
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
enforced_by:
  - tests/harness/scenarios/cli-surface/capture-ingest-captured-block.scenario.test.ts
tier: shipped-default
---

# INBOX_IS_EPHEMERAL

**Tier:** Shipped default — `dome.agent` is opt-in, but once enabled it carries the inbox-staleness check by default; per-bucket disable in `<vault>/.dome/config.yaml` is deferred to v1.1+.

**Statement:** Files in `<vault>/inbox/<bucket>/` (excluding `inbox/review/` and `inbox/processed/`) are expected to be moved or deleted by the bucket's ingest processor within 168 hours. Files lingering past the threshold are surfaced as `DiagnosticEffect` by the `dome.agent` garden-phase stale-check processor.

**Why:** The inbox-as-drop-zone pattern (a phone widget writes raw markdown to `inbox/raw/`; a share-sheet writes to `inbox/clip/`; the `dome.agent` garden-phase processor integrates them into wiki updates) only works if files don't accumulate. Persistent inbox files indicate either: (a) the ingest processor is broken or quarantined; (b) the LLM failed and budget was exhausted; (c) the bucket is wrong for the captured content. All three deserve visibility.

**Implementation status:** Shipped for the v1 diagnostic loop.
`dome.agent.ingest` archives processed `inbox/raw/*.md` captures to
`inbox/processed/`, and `dome.agent.inbox-stale-check` emits
`inbox.stale` warnings for old files under active inbox buckets. A
lint/apply disposition surface and configurable thresholds remain planned.

**Target structural enforcement:**

1. **`dome.agent.inbox-stale-check`** is a garden-phase processor that runs on an hourly schedule and on relevant inbox path changes. It walks `inbox/<bucket>/*.md` (excluding `inbox/review/` and `inbox/processed/`) and emits a `DiagnosticEffect { severity: "warning", code: "inbox.stale" }` for each file older than 168 hours.
2. **`dome lint` includes inbox-stale findings.** A lint report names every stale file with a finding id; a future apply flow can invoke the user-selected disposition (re-attempt ingest via `dome.agent`, archive to `inbox/processed/`, delete).
3. **Garden-phase `dome.agent.ingest`** archives successfully-processed captures to `inbox/processed/` automatically — the "expected to move out" half of the contract.
4. **`dome inspect diagnostics --code inbox.stale`** surfaces the stale set on demand (the previous pre-recut `dome doctor --inbox-stale` flag is retired in favor of querying the unified diagnostics table).

The v1 threshold is a fixed 168 hours. A configurable `engine.inbox_stale_age_hours` value and per-bucket thresholds (e.g., `inbox/voice/` stale at 1 hour vs `inbox/research/` stale at 30 days) are v1.1+ features.

**Counter-example:** The `dome.agent.ingest` processor is quarantined because it crashed on a malformed input. New captures land in `inbox/raw/` and accumulate. After 7 days, the garden-phase inbox-stale-check fires a warning diagnostic for each lingering file. The user runs `dome check --json` to see the stale diagnostics and quarantine decision. The quarantine-recovery flow follows the engine-asks model: the `dome.health.quarantine-recovery-questions` processor emits a `QuestionEffect`; the user answers `dome resolve <question-id> reset` (un-quarantine the processor on next adoption) or `ignore` (leave quarantined); the `dome.health.quarantine-recovery-answer` garden-phase processor emits `QuarantineRecoveryEffect`; next `dome sync` re-processes the backlog. (The pre-recut `dome doctor --reset-quarantined-processors` flag is retired.)

**Required test guarantee:** a stale-inbox scenario re-homes under the `dome.agent.inbox-stale-check` processor — create an old file under an active inbox bucket, assert one `inbox.stale` warning, then delete the file and assert the diagnostic resolves.

**Related:**
- [[wiki/specs/vault-layout]] §"`inbox/`"
- [[wiki/specs/processors]] §"First-party processors"
- [[wiki/specs/effects]] §"DiagnosticEffect"
- [[wiki/specs/autonomous-agents]] — the `dome.agent.ingest` processor and `dome.agent.inbox-stale-check`
- [[wiki/gotchas/scheduled-hook-idempotency]] — at-most-once-per-sync clamp applies to the stale check
