---
type: invariant
created: 2026-05-27
updated: 2026-05-29
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
tier: shipped-default
---

# INBOX_IS_EPHEMERAL

**Tier:** Shipped default — `dome.intake` is opt-in, but once enabled it carries the inbox-staleness check by default; per-bucket disable in `<vault>/.dome/config.yaml` is deferred to v1.1+.

**Statement:** Files in `<vault>/inbox/<bucket>/` (excluding `inbox/review/` and `inbox/processed/`) are expected to be moved or deleted by the bucket's intake processor within 168 hours. Files lingering past the threshold are surfaced as `DiagnosticEffect` by the `dome.intake` garden-phase stale-check processor.

**Why:** The inbox-as-drop-zone pattern (a phone widget writes raw markdown to `inbox/raw/`; a share-sheet writes to `inbox/clip/`; the `dome.intake` garden-phase processor compiles them into wiki updates) only works if files don't accumulate. Persistent inbox files indicate either: (a) the intake processor is broken or quarantined; (b) the LLM failed to compile a low-confidence capture and the user needs to triage; (c) the bucket is wrong for the captured content. All three deserve visibility.

**Implementation status:** Shipped for the v1 diagnostic loop.
`dome.intake.extract-capture` archives processed `inbox/raw/*.md` captures to
`inbox/processed/`, and `dome.intake.inbox-stale-check` emits
`inbox.stale` warnings for old files under active intake buckets. A
lint/apply disposition surface and configurable thresholds remain planned.

**Target structural enforcement:**

1. **`dome.intake.inbox-stale-check`** is a garden-phase processor that runs on an hourly schedule and on relevant inbox path changes. It walks `inbox/<bucket>/*.md` (excluding `inbox/review/` and `inbox/processed/`) and emits a `DiagnosticEffect { severity: "warning", code: "inbox.stale" }` for each file older than 168 hours.
2. **`dome lint` includes inbox-stale findings.** A lint report names every stale file with a finding id; a future apply flow can invoke the user-selected disposition (re-attempt compile via `dome.intake`, archive to `inbox/processed/`, delete).
3. **Garden-phase `dome.intake.extract-capture`** archives successfully-processed captures to `inbox/processed/` automatically — the "expected to move out" half of the contract.
4. **`dome inspect diagnostics --code inbox.stale`** surfaces the stale set on demand (the previous pre-recut `dome doctor --inbox-stale` flag is retired in favor of querying the unified diagnostics table).

The v1 threshold is a fixed 168 hours. A configurable `engine.inbox_stale_age_hours` value and per-bucket thresholds (e.g., `inbox/voice/` stale at 1 hour vs `inbox/research/` stale at 30 days) are v1.1+ features.

**Counter-example:** The `dome.intake` extract-capture processor is quarantined because it crashed on a malformed input. New captures land in `inbox/raw/` and accumulate. After 7 days, the garden-phase inbox-stale-check fires a warning diagnostic for each lingering file. The user runs `dome inspect diagnostics --code inbox.stale` and `dome inspect questions` to see the situation. The quarantine-recovery flow follows the engine-asks model: the `dome.health.quarantine-recovery-questions` processor emits a `QuestionEffect`; the user answers `dome answer <question-id> reset` (un-quarantine the processor on next adoption) or `ignore` (leave quarantined); the `dome.health.quarantine-recovery-answer` garden-phase processor emits `QuarantineRecoveryEffect`; next `dome sync` re-processes the backlog. (The pre-recut `dome doctor --reset-quarantined-processors` flag is retired.)

**Test guarantee:** `tests/harness/scenarios/effect-kinds/intake-extract-capture.scenario.test.ts` includes a stale-inbox scenario: it creates an old file under an active intake bucket, asserts one `inbox.stale` warning, then deletes the file and asserts the diagnostic resolves.

**Related:**
- [[wiki/specs/vault-layout]] §"`inbox/`"
- [[wiki/specs/processors]] §"First-party processors"
- [[wiki/specs/effects]] §"DiagnosticEffect"
- [[wiki/gotchas/scheduled-hook-idempotency]] — at-most-once-per-sync clamp applies to the stale check
