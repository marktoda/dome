---
type: gotcha
created: 2026-05-26
updated: 2026-05-26
severity: medium
coverage: off-matrix
first_observed: 2026-05-26
sources: ["[[cohesive/brainstorms/2026-05-26-dome-compiler-reframe]]"]
---

# Daemon off while vault mutating

**Symptom:** `dome serve` isn't running. The user continues writing into the vault — via Claude Code, vim, Obsidian, or any other consumer shell. Hours or days later, they restart `dome serve` (or invoke `dome reconcile` directly) and the startup phase takes noticeably longer than usual: the watcher's catch-up scans, the git-diff replay processes the accumulated changes, intake hooks fire on `inbox/<bucket>/` files that piled up, scheduled hooks fire for every interval that elapsed. Sometimes the catch-up triggers LLM-driven workflows (every accumulated `inbox/raw/` file invokes `ingest`), accumulating real API cost.

**Root cause:** Dome's compiler is daemon-shaped. When `dome serve` is running, the watcher fires reactive hooks within sub-second latency of native writes. When it's off, native writes still happen — Claude Code's `Write`, vim, Obsidian — but no listener is observing them in real time. The events queue up *implicitly* as git working-tree state and `inbox/<bucket>/` filesystem state; `dome reconcile` (which `dome serve` runs at startup, and which the user can invoke directly) drains the queue by replaying events derived from `git diff` and inbox-directory walks.

This is correctness-preserving by design (per [[wiki/invariants/VAULT_RECONCILES_AFTER_NATIVE_WRITE]]) — the catch-up is idempotent and durable. But it has a real cost that grows linearly with time-since-last-reconcile:

- **Filesystem traversal cost** — proportional to vault size (mostly fast).
- **Git-diff replay cost** — proportional to the number of changed files since `last-reconciled-sha.txt`. For a vault under active editing during the daemon's downtime, this can be hundreds of files.
- **Hook execution cost** — proportional to the events × hooks-per-event. Mostly cheap (`auto-update-index`, `appendLog`).
- **LLM cost (when intake hooks are active)** — proportional to the number of `inbox/<bucket>/` files that accumulated. Each file triggers the corresponding intake workflow (ingest, voice-ingest, etc.) which calls the model. *This is the only cost component that's noticeable in dollars and time.*

**Why the existing structural mitigation works** (per [[wiki/invariants/VAULT_RECONCILES_AFTER_NATIVE_WRITE]]): `dome reconcile`'s three-phase design (inbox processing, git-diff replay, scheduled catchup) is durable and idempotent. State persistence in `.dome/state/last-reconciled-sha.txt` + `.dome/state/scheduled.json` survives the daemon being off; the next reconcile picks up exactly where the last one left off. No data is lost; no events are missed at the correctness level. The concern is *cost and latency*, not *correctness*.

**Operational mitigations:**

- **Run `dome serve` as a launchd / systemd service.** The recommended deployment for users who want continuous compilation. Cost stays bounded because the queue stays drained.
- **Use `dome doctor --time-since-reconcile`** to surface drift age in CI / scripts / habitual checks. The metric tells the user when to schedule a reconcile if they've been running ad-hoc.
- **Cap intake-hook LLM cost** with a per-batch `max_intake_files` config in `.dome/config.yaml` (proposed; not yet shipped) — if `dome reconcile` finds more than N pending intake files, it processes the first N and leaves the rest for the next reconcile, surfacing the deferral as a warning. This is a future enhancement; v0.5 processes everything in one pass.

**What NOT to do:**

- Don't disable intake hooks to "avoid the catch-up cost." If you don't want LLM-driven ingest at all, don't enable it as a hook in the first place. Disabling on the fly to avoid catch-up just defers the cost until the user re-enables.
- Don't manually `rm .dome/state/last-reconciled-sha.txt` to "force a clean reconcile." That recovery path exists (deleting the state file makes the next reconcile treat every git-tracked file as changed — a full re-walk) but it's a heavy hammer; usually the right move is to let reconcile do its incremental catch-up.

**Counter-example (the bad case before mitigation):** A user disables `dome serve` for two weeks while traveling. The vault accumulates 200 inbox/raw/ captures and dozens of out-of-band wiki edits. On return, the user runs `dome serve`; the auto-reconcile at startup fires 200 ingest workflows back-to-back, consuming hours of LLM time and significant API cost — most of which the user no longer remembers wanting. With the operational mitigations: `dome serve` running as a launchd service throughout the trip would have kept the queue drained (each capture compiled within a minute of being written). The trip's worth of compilation cost was the same total; it just spread over time and didn't surprise the user at restart.

**Related:**
- [[wiki/invariants/VAULT_RECONCILES_AFTER_NATIVE_WRITE]] — the correctness story this gotcha clarifies the cost shape of.
- [[wiki/specs/cli]] §"`dome reconcile`" — the catch-up mechanism.
- [[wiki/specs/cli]] §"`dome doctor`" `--time-since-reconcile` flag.
- [[wiki/gotchas/out-of-band-vault-edits]] — the canonical-path framing for native writes.
- [[wiki/specs/harnesses]] §"The compiler-boundary contract" — the four-surface contract this gotcha names a cost-edge of.
