---
type: gotcha
created: 2026-05-27
updated: 2026-05-27
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
severity: medium
coverage: off-matrix
enforced_at: tests/integration/scheduled-processors.test.ts
enforced_at_status: deferred
first_observed: 2026-05-27
---

# Scheduled processor idempotency

**Note on filename:** This gotcha was created pre-v1 under the name "scheduled-hook-idempotency"; the filename is preserved for stable wiki links and cross-references from carried-forward substrate. The canonical concept in v1 is the **scheduled-trigger processor** — a Processor (per [[wiki/specs/processors]]) with `triggers: [{ kind: "schedule", cron: "..." }]`.

**Symptom:** A scheduled-trigger garden-phase processor with `triggers: [{ kind: "schedule", cron: "0 6 * * *" }]` creates today's daily note. The user is offline / `dome serve` is off for three days, then runs `dome sync`. Without thinking, the user expects the processor to fire three times (once per missed day) and produce three daily-note creates. Either the processor duplicates effects (three identical creates emit identical PatchEffects against `wiki/dailies/<today>.md` and re-converge at the same fixed point — wasteful), OR the processor's idempotency guard catches it and the cost is just three wasted runs in the ledger.

The mirror failure: the user assumes scheduled processors never re-fire on catch-up and runs `dome sync` after a week offline. The weekly-rollup processor is supposed to produce one rollup per week; the user wakes up to a vault missing seven weeks of rollups because the processor "skipped catch-up."

**Root cause:** Scheduled-trigger processors (per [[wiki/specs/processors]] §"Triggers and signals") interact with the engine's catch-up semantic in a way that's load-bearing but counterintuitive. The engine's schedule cursors (per [[wiki/specs/projection-store]] §"schedule_cursors") track per-processor last-fire times. Without a per-sync clamp, `dome sync` would fire each scheduled processor once per elapsed interval since last fire — three days offline = three ticks fired.

**Severity:** Medium. The data-loss direction (no catch-up at all → missed rollups) is silent if the user doesn't notice the missing files. The duplicate-fire direction (N fires for N intervals, wasting LLM cost and ledger rows) is loud but recoverable. Neither is catastrophic — the vault still works — but both violate the user's mental model of "scheduled processors fire on schedule, with reasonable catch-up."

**Structural mitigation:** Three parts:

1. **Default catch-up is clamped to at-most-once-per-sync.** `dome sync`'s scheduled-trigger dispatch fires each scheduled processor **at most once per sync invocation, regardless of how many intervals elapsed.** A daily-schedule processor off for three days fires once on the next sync. This is the v1 default; the scheduled-trigger contract documents the semantic explicitly so processor authors don't expect three fires.

2. **The processor's idempotency contract** (per [[wiki/specs/processors]] §"Idempotency") means a processor that fires on a missed interval against the same `(snapshot, input)` produces the same effects on every run. The fixed-point loop converges; duplicate emissions to the projection store deduplicate via uniqueness constraints; cost is real but bounded.

3. **The lockstep test at `tests/integration/scheduled-processors.test.ts`** asserts the at-most-once-per-sync semantic. A test fixture creates a scheduled-trigger processor, advances the clock three intervals, runs sync, asserts the processor fires exactly once and the RunRecord shows the elapsed-interval delta in its `trigger_payload_json` field.

**Specific scenarios:**

- The first-party `dome.daily.create-daily` processor declares `triggers: [{ kind: "schedule", cron: "0 6 * * *" }]`. The processor internally checks the candidate snapshot for `wiki/dailies/<today>.md`; if present, emits no PatchEffect (idempotent no-op). A user off for three days syncs, the processor fires once (per clamp), the PatchEffect creates today's daily (the other two days stay un-created — the v1 backfill path is to invoke `dome run-processor dome.daily:create-daily --args='{"date":"<YYYY-MM-DD>"}'` for each missed date).

- A third-party `acme.nightly-export` processor with `triggers: [{ kind: "schedule", cron: "0 2 * * *" }]` and `external: ["network.post"]` capability. A user off for a week syncs, the processor fires once (per clamp), one nightly-export attempt lands in the outbox per [[wiki/invariants/EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX]]. The other six nights' exports are lost — which is fine because exports are non-idempotent side effects that shouldn't be silently re-fired against external systems.

- A processor author writes a `weekly-rollup` view-phase processor with `triggers: [{ kind: "schedule", cron: "0 18 * * 0" }]` and forgets the internal "does the rollup already exist" guard. A user syncs after two weeks offline; the processor fires once (per clamp), emits a PatchEffect writing the rollup for the most-recent week, the prior week is missed. The author notices and either adds the guard (idempotency per [[wiki/specs/processors]] §"Idempotency") or accepts the lossy-on-catch-up semantic.

**Related:**

- [[wiki/specs/processors]] §"Triggers and signals" — the scheduled-trigger form.
- [[wiki/specs/processors]] §"Idempotency" — the broader contract.
- [[wiki/specs/projection-store]] §"schedule_cursors" — where last-fire times persist.
- [[wiki/specs/adoption]] — the sync that drives scheduled catch-up.
- [[wiki/gotchas/processor-idempotency]] — sibling gotcha; processors that aren't idempotent break worse than this case.
