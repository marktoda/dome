---
type: gotcha
created: 2026-05-26
updated: 2026-05-27
severity: medium
coverage: off-matrix
enforced_at: src/adoption.ts
first_observed: 2026-05-26
sources: ["[[cohesive/brainstorms/2026-05-26-dome-compiler-reframe]]", "[[cohesive/delta-ledgers/2026-05-27-phase-1-3-adopted-ref-and-patch-trailers]]"]
---

# Daemon off while vault mutating

**Symptom:** `dome serve` isn't running. The user continues writing into the vault — via Claude Code, vim, Obsidian, or any other consumer shell. Hours or days later, they restart `dome serve` (or invoke `dome sync` directly) and the startup phase takes noticeably longer than usual: the watcher's catch-up scans, the git-diff replay processes the accumulated changes (the diff range is `refs/dome/adopted/<branch>..HEAD` plus the working-tree diff per [[wiki/specs/adoption]]), intake hooks fire on `inbox/<bucket>/` files that piled up, scheduled hooks fire for every interval that elapsed. Sometimes the catch-up triggers LLM-driven workflows (every accumulated `inbox/raw/` file invokes `ingest`), accumulating real API cost.

**Root cause:** Dome's compiler is daemon-shaped. When `dome serve` is running, the watcher fires reactive hooks within sub-second latency of native writes. When it's off, native writes still happen — Claude Code's `Write`, vim, Obsidian — but no listener is observing them in real time. The events queue up *implicitly* as git working-tree state and `inbox/<bucket>/` filesystem state; `dome sync` (which `dome serve` runs at startup, and which the user can invoke directly; `dome reconcile` is the deprecated alias) drains the queue by replaying events derived from `git diff refs/dome/adopted/<branch>..HEAD` and inbox-directory walks.

This is correctness-preserving by design (per [[wiki/invariants/VAULT_RECONCILES_AFTER_NATIVE_WRITE]] and [[wiki/invariants/ADOPTED_REF_IS_SEMANTIC_CURSOR]]) — the catch-up is idempotent and durable. But it has a real cost that grows linearly with time-since-last-sync:

- **Filesystem traversal cost** — proportional to vault size (mostly fast).
- **Git-diff replay cost** — proportional to the number of changed files in `refs/dome/adopted/<branch>..HEAD` plus the working-tree diff. For a vault under active editing during the daemon's downtime, this can be hundreds of files.
- **Hook execution cost** — proportional to the events × hooks-per-event. Mostly cheap (`auto-update-index`, `appendLog`).
- **LLM cost (when intake hooks are active)** — proportional to the number of `inbox/<bucket>/` files that accumulated. Each file triggers the corresponding intake workflow (ingest, voice-ingest, etc.) which calls the model. *This is the only cost component that's noticeable in dollars and time.*

**Why the existing structural mitigation works** (per [[wiki/invariants/VAULT_RECONCILES_AFTER_NATIVE_WRITE]] + [[wiki/invariants/ADOPTED_REF_IS_SEMANTIC_CURSOR]]): `dome sync`'s adoption state machine (per [[wiki/specs/adoption]] §"The adoption state machine") is durable and idempotent. The canonical "have I compiled this revision" cursor is `refs/dome/adopted/<branch>` — a first-class git ref that survives the daemon being off and any number of process crashes. State persistence in `.dome/state/scheduled.json` (for scheduled-hook last-fire times) and `.dome/state/quarantined.json` (for quarantined handlers) similarly survives; the next sync picks up exactly where the last one left off. No data is lost; no events are missed at the correctness level. The concern is *cost and latency*, not *correctness*.

**Operational mitigations:**

- **Run `dome serve` as a launchd / systemd service.** The recommended deployment for users who want continuous compilation. Cost stays bounded because the queue stays drained — `refs/dome/adopted/<branch>` advances to HEAD on each auto-sync, leaving no pending range.
- **Use `dome status`** to surface the adoption snapshot at any time — branch / HEAD / adopted / pending commits / dirty-tree state. The pending-commits count tells the user how much catch-up the next sync will do.
- **Use `dome doctor --time-since-reconcile`** to surface drift age in CI / scripts / habitual checks. Reads from `.dome/state/last-reconcile-mtime.txt` mtime (or the legacy `.dome/state/last-reconciled-sha.txt` mtime as a fallback for vaults migrating from v0.5 pre-phase1+phase3 per [[wiki/specs/adoption]] §"Migration from v0.5"). The metric tells the user when to schedule a sync if they've been running ad-hoc.
- **Cap intake-hook LLM cost** with a per-batch `max_intake_files` config in `.dome/config.yaml` (proposed; not yet shipped) — if `dome sync` finds more than N pending intake files, it processes the first N and leaves the rest for the next sync, surfacing the deferral as a warning. This is a future enhancement; v0.5+phase1+phase3 processes everything in one pass.

**What NOT to do:**

- Don't disable intake hooks to "avoid the catch-up cost." If you don't want LLM-driven ingest at all, don't enable it as a hook in the first place. Disabling on the fly to avoid catch-up just defers the cost until the user re-enables.
- Don't manually `git update-ref -d refs/dome/adopted/<branch>` to "force a clean sync." That recovery path exists (deleting the adopted ref initializes it again at the next `dome sync`, which treats every committed file in HEAD as already-compiled per the migration story — not actually a "re-walk everything" reset; for that you'd also need to delete `.dome/state/scheduled.json` and reset working-tree files). The right move is usually to let sync do its incremental catch-up.

**Counter-example (the bad case before mitigation):** A user disables `dome serve` for two weeks while traveling. The vault accumulates 200 inbox/raw/ captures and dozens of out-of-band wiki edits. On return, the user runs `dome serve`; the auto-sync at startup fires 200 ingest workflows back-to-back, consuming hours of LLM time and significant API cost — most of which the user no longer remembers wanting. With the operational mitigations: `dome serve` running as a launchd service throughout the trip would have kept the queue drained (each capture compiled within a minute of being written, the adopted ref advancing per sync). The trip's worth of compilation cost was the same total; it just spread over time and didn't surprise the user at restart.

**Related:**
- [[wiki/invariants/VAULT_RECONCILES_AFTER_NATIVE_WRITE]] — the correctness story this gotcha clarifies the cost shape of.
- [[wiki/invariants/ADOPTED_REF_IS_SEMANTIC_CURSOR]] — pins the cursor whose advance defines "the queue is drained."
- [[wiki/specs/adoption]] §"The adoption state machine" — the sync flow this gotcha names a cost-edge of.
- [[wiki/specs/cli]] §"`dome sync`" — the catch-up mechanism.
- [[wiki/specs/cli]] §"`dome status`" — the snapshot surface for the pending count.
- [[wiki/specs/cli]] §"`dome doctor`" `--time-since-reconcile` flag.
- [[wiki/gotchas/out-of-band-vault-edits]] — the canonical-path framing for native writes.
- [[wiki/gotchas/adopted-ref-divergence]] — the sibling "catch-up refused because state is wrong" diagnostic.
- [[wiki/specs/harnesses]] §"The compiler-boundary contract" — the four-surface contract this gotcha names a cost-edge of.
