---
type: gotcha
created: 2026-05-27
updated: 2026-05-27
severity: medium
coverage: off-matrix
enforced_at: src/engine/adopt.ts
enforced_at_status: deferred
first_observed: 2026-05-27
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
---

# Daemon off while vault mutating

**Symptom:** `dome serve` isn't running. The user continues writing into the vault — via Claude Code, vim, Obsidian, or any other consumer shell. Hours or days later, they restart `dome serve` (or invoke `dome sync` directly) and the startup phase takes noticeably longer than usual: the watcher's catch-up scans, the engine constructs a Proposal spanning the accumulated `refs/dome/adopted/<branch>..HEAD` plus working-tree diff (per [[wiki/specs/adoption]]), adoption-phase processors run, garden-phase processors fire on the post-adopt state (intake processors compile every accumulated `inbox/<bucket>/` file, scheduled processors fire for every cron interval that elapsed). Sometimes the catch-up triggers many LLM-backed runs (every accumulated `inbox/raw/` file invokes `dome.intake.extract-capture`), accumulating real API cost.

**Root cause:** Dome's compiler is daemon-shaped. When `dome serve` is running, the watcher constructs a Proposal within sub-second latency of each native write; the engine adopts; garden processors fire shortly after. When `dome serve` is off, native writes still happen — Claude Code's `Write`, vim, Obsidian — but no listener is observing them in real time. The changes queue up *implicitly* as git working-tree state and `inbox/<bucket>/` filesystem state; `dome sync` drains the queue by constructing a single Proposal that captures all accumulated changes and routing it through the adoption loop, then garden processors fire on the post-adopt state.

This is correctness-preserving by design (per [[wiki/invariants/ALL_MUTATION_GOES_THROUGH_ADOPTION]] and [[wiki/invariants/ADOPTED_REF_IS_SEMANTIC_CURSOR]]) — the catch-up is idempotent and durable. But it has a real cost that grows linearly with time-since-last-sync:

- **Filesystem traversal cost** — proportional to vault size (mostly fast).
- **Adoption loop cost** — proportional to the number of changed files in `refs/dome/adopted/<branch>..HEAD` plus the working-tree diff times the number of adoption-phase processors. For a vault under active editing during the daemon's downtime, this can be hundreds of files. Linear, bounded by `MAX_ITER` (default 100) per Proposal.
- **Garden processor cost** — proportional to the number of signals × matching garden processors. Mostly cheap (`dome.links.cross-reference`, schedule-driven processors firing once per missed interval per the at-most-once-per-sync clamp).
- **LLM cost (when intake processors fire)** — proportional to the number of `inbox/<bucket>/` files that accumulated. Each file triggers the corresponding garden-LLM processor (`dome.intake.extract-capture` for `inbox/raw/*`; analogues for opt-in buckets) which calls the model. *This is the only cost component that's noticeable in dollars and time.* The `model.invoke` capability's `maxDailyCostUsd` cap (per [[wiki/specs/capabilities]] §"model.invoke") backstops the spend; beyond the cap, the processor's `modelInvoke` calls are denied and the work is deferred to the next day's sync.

**Why the existing structural mitigation works** (per [[wiki/invariants/ALL_MUTATION_GOES_THROUGH_ADOPTION]] + [[wiki/invariants/ADOPTED_REF_IS_SEMANTIC_CURSOR]]): `dome sync`'s adoption loop is durable and idempotent. The canonical "have I adopted this revision" cursor is `refs/dome/adopted/<branch>` — a first-class git ref that survives the daemon being off and any number of process crashes. Engine state in `<vault>/.dome/state/projection.db.schedule_cursors` (for scheduled-processor last-fire times) and `<vault>/.dome/state/quarantined.json` (for quarantined processors) similarly survives; the next sync picks up exactly where the last one left off. No data is lost; no events are missed at the correctness level. The concern is *cost and latency*, not *correctness*.

**Operational mitigations:**

- **Run `dome serve` as a launchd / systemd service.** The recommended deployment for users who want continuous compilation. Cost stays bounded because each Proposal stays small — the adopted ref advances frequently, leaving no pending range.
- **Use `dome status`** to surface the adoption snapshot at any time — branch / HEAD / adopted / pending commits / dirty-tree state / pending outbox / runs summary. The pending-commits count tells the user how much catch-up the next sync will do.
- **Use `dome status`** to surface the pending-commits count and drift state — the v1.0 canonical answer. A future `dome show drift-age` subject (v1.x, reads the `.dome/state/last-reconcile-mtime.txt` marker; supersedes the retired `dome doctor --time-since-reconcile` flag) surfaces drift age in CI / scripts / habitual checks once the marker semantics are settled.
- **Cap intake-processor LLM cost** via the `model.invoke.maxDailyCostUsd` capability grant in `<vault>/.dome/config.yaml`. The `dome.intake.extract-capture` processor's default cap is $5/day; once exceeded, the processor's `modelInvoke` calls are denied for the rest of the day. Accumulated files re-process the next day. Configurable per-vault per [[wiki/specs/capabilities]] §"model.invoke".

**What NOT to do:**

- Don't disable garden-LLM processors to "avoid the catch-up cost." If you don't want LLM-driven ingest at all, disable the `dome.intake` bundle in `<vault>/.dome/config.yaml`. Disabling on the fly to avoid catch-up just defers the cost until you re-enable.
- Don't manually `git update-ref -d refs/dome/adopted/<branch>` to "force a clean sync." That recovery path exists (deleting the adopted ref initializes it again at the next `dome sync`, which treats every committed file in HEAD as already-adopted per the migration story in [[wiki/specs/adoption]] §"Migration from v0.5+phase1+phase3" — not actually a "re-walk everything" reset). The right move is usually to let sync do its incremental catch-up.

**Counter-example (the bad case before mitigation):** A user disables `dome serve` for two weeks while traveling. The vault accumulates 200 inbox/raw/ captures and dozens of native wiki edits. On return, the user runs `dome serve`; the auto-sync at startup constructs a Proposal spanning the full range; adoption runs; the post-adopt state fires 200 garden-LLM intake runs back-to-back. The first $5 of LLM spend happens; the cap denies further model invokes; the remaining captures sit until the next day's sync. With the operational mitigations: `dome serve` running as a launchd service throughout the trip would have kept the adopted ref advancing daily (each capture compiled within minutes of being written). The trip's worth of compilation cost was the same total; it just spread over time and didn't compress into one cap-exhausting burst.

**Related:**
- [[wiki/invariants/ALL_MUTATION_GOES_THROUGH_ADOPTION]] — the correctness story this gotcha clarifies the cost shape of.
- [[wiki/invariants/ADOPTED_REF_IS_SEMANTIC_CURSOR]] — pins the cursor whose advance defines "the queue is drained."
- [[wiki/specs/adoption]] §"The fixed-point adoption loop" — the sync flow this gotcha names a cost-edge of.
- [[wiki/specs/processors]] §"Garden phase" — where the LLM-backed work runs.
- [[wiki/specs/capabilities]] §"model.invoke" — the LLM cost cap.
- [[wiki/specs/cli]] §"`dome sync`" — the catch-up mechanism.
- [[wiki/specs/cli]] §"`dome status`" — the snapshot surface.
- [[wiki/specs/cli]] §"`dome show`" — the drift-age subject (v1.x); also §"`dome status`" for the v1.0 pending-commits surface.
- [[wiki/gotchas/out-of-band-vault-edits]] — the canonical-path framing for native writes.
- [[wiki/gotchas/adopted-ref-divergence]] — the sibling "catch-up refused because state is wrong" diagnostic.
- [[wiki/specs/harnesses]] §"The compiler-boundary contract" — the four-surface contract.
