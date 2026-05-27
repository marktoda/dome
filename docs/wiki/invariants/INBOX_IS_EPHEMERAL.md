---
type: invariant
created: 2026-05-27
updated: 2026-05-27
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
tier: shipped-default
---

# INBOX_IS_EPHEMERAL

**Tier:** Shipped default — enabled by default; per-bucket disable in `<vault>/.dome/config.yaml` is deferred to v1.1+.

**Statement:** Files in `<vault>/inbox/<bucket>/` (excluding `inbox/review/`, the lint-report destination) are expected to be moved or deleted by the bucket's intake processor within `engine.inbox_stale_age_hours` (default 168 = 7 days) of creation. Files lingering past the threshold are surfaced as DiagnosticEffect by the `dome.intake` adoption-phase processor on every sync.

**Why:** The inbox-as-drop-zone pattern (a phone widget writes raw markdown to `inbox/raw/`; a share-sheet writes to `inbox/clip/`; the `dome.intake` garden-phase processor compiles them into wiki updates) only works if files don't accumulate. Persistent inbox files indicate either: (a) the intake processor is broken or quarantined; (b) the LLM failed to compile a low-confidence capture and the user needs to triage; (c) the bucket is wrong for the captured content. All three deserve visibility.

**Structural enforcement:**

1. **`dome.intake.inbox-stale-check`** is an adoption-phase processor that walks `inbox/<bucket>/*` (excluding `inbox/review/` and `inbox/processed/`) on every sync and emits a `DiagnosticEffect { severity: "warning", code: "inbox.stale" }` for each file older than `engine.inbox_stale_age_hours`.
2. **`dome lint` includes inbox-stale findings.** A lint report names every stale file with a finding id; `dome lint --apply <id>` invokes the user-selected disposition (re-attempt compile via `dome.intake`, archive to `inbox/processed/`, delete).
3. **Garden-phase `dome.intake.extract-capture`** archives successfully-processed captures to `inbox/processed/` automatically — the "expected to move out" half of the contract.
4. **`dome doctor --inbox-stale`** surfaces the stale set on demand.

The threshold lives in `<vault>/.dome/config.yaml` as `engine.inbox_stale_age_hours` (an integer). Set arbitrarily high to disable the check effectively. Per-bucket thresholds (e.g., `inbox/voice/` stale at 1 hour vs `inbox/research/` stale at 30 days) are a v1.1+ feature.

**Counter-example:** The `dome.intake` extract-capture processor is quarantined because it crashed on a malformed input. New captures land in `inbox/raw/` and accumulate. After 7 days, the adoption-phase inbox-stale-check fires a warning diagnostic for each lingering file. The user runs `dome doctor --inbox-stale`, sees the list, runs `dome doctor --reset-quarantined-processors` to un-quarantine `dome.intake`, then `dome sync` to re-process the backlog.

**Test guarantee:** `tests/invariants/inbox-is-ephemeral.test.ts` — initializes a fixture vault with one fresh and one 8-day-old file under `inbox/raw/`; runs `dome sync`; asserts the diagnostic table contains one `inbox.stale` entry for the old file and none for the fresh.

**Related:**
- [[wiki/specs/vault-layout]] §"`inbox/`"
- [[wiki/specs/processors]] §"First-party processors"
- [[wiki/specs/effects]] §"DiagnosticEffect"
- [[wiki/gotchas/scheduled-hook-idempotency]] — at-most-once-per-sync clamp applies to the stale check
