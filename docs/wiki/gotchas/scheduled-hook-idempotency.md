---
type: gotcha
created: 2026-05-26
updated: 2026-05-26
sources: ["[[cohesive/brainstorms/2026-05-26-dome-hooks-v1-roadmap]]"]
severity: medium
coverage: off-matrix
enforced_at: tests/integration/scheduled-hooks.test.ts
first_observed: 2026-05-26
---

# Scheduled hook idempotency

**Symptom:** A declarative hook with `schedule: "0 6 * * *"` (fire daily at 6am) creates today's daily note. The user is offline / `dome serve` is off for three days, then runs `dome reconcile`. Without thinking, they declare the hook `idempotent: true`. Reconcile's Phase 3 fires the hook *three times* (once per missed interval), and the user lands with three calls to `create-daily` for the same target. Either the hook duplicates effects (three identical creates → conflict on existing-file detection if writeDocument is loose; three appended sections if writeDocument is loose; etc.), OR the hook's "is today already created?" guard inside the workflow catches it and the cost is just three wasted LLM calls.

The mirror failure: the user declares `idempotent: false` and runs `dome reconcile`. Phase 3 SKIPS the hook on reconcile per the hooks-spec contract — so the three missed daily creates *never* happen, and the user wakes up to a vault missing three days of daily notes that the schedule was supposed to produce.

**Root cause:** Scheduled hooks (declarative YAML with a `schedule:` field) interact with the existing idempotency contract in a way that's load-bearing but counterintuitive. The contract was designed for *event-reactive* hooks where the event itself is a fact ("`document.written.wiki.entity` fired; the file is on disk now"). For scheduled hooks the event is a *cadence intent* ("the 6am-daily clock tick was supposed to fire at some point in this window"). Reconcile's Phase 3 fires `clock.tick.<schedule-id>` for every elapsed interval since the last recorded fire — three days offline = three ticks fired.

The `idempotent: true` declaration triggers reconcile-time re-fire; `idempotent: false` opts out of reconcile entirely. Neither captures the scheduled-hook semantic: "I want exactly one fire per interval, but I want catch-up if I missed intervals — clamped to a sensible max so 30 days offline doesn't fire 30 daily-creates back-to-back."

**Severity:** Medium. The data-loss direction (`idempotent: false` → missed creates) is silent if the user doesn't notice the missing files. The duplicate-fire direction (`idempotent: true` without internal guard) wastes LLM cost and can produce duplicate writes if the workflow doesn't self-guard. Neither is catastrophic — the vault still works — but both violate the user's mental model of "scheduled hooks fire on schedule, with reasonable catch-up."

**Structural mitigation:** Three parts:

1. **Default catch-up is clamped.** `dome reconcile` Phase 3 fires each scheduled hook **at most once per reconcile run, regardless of how many intervals elapsed.** A daily-schedule hook off for three days fires once on the next reconcile. This is the v0.5 default; the scheduled-hook contract documents the semantic explicitly so authors don't expect three fires.

2. **The `idempotent:` declaration on scheduled hooks means something narrower than for event-reactive hooks.** For a scheduled hook, `idempotent: true` means "safe to re-fire if reconcile catch-up runs; my workflow guards against duplicate effects internally." `idempotent: false` means "skip me on reconcile catch-up entirely; only fire from a live clock tick when `dome serve` is running." The scheduled-hook section of `hooks.md` documents this distinction.

3. **The lockstep test at `tests/integration/scheduled-hooks.test.ts`** asserts the at-most-once-per-reconcile semantic. A test fixture creates a scheduled hook, advances the clock three intervals, runs reconcile, and asserts the hook fires exactly once.

The default for new scheduled hooks declared without an explicit `idempotent:` field is **`idempotent: true`** (matching the event-reactive default), with the explicit understanding that the at-most-once-per-reconcile clamp covers the common case. Authors who want strict "live-fire-only" semantics opt out via `idempotent: false`; authors who want "fire N times if N intervals elapsed" are out of scope for v0.5 (that's a per-bundle workflow that issues N writes in one fire, not N hook fires).

**Specific scenarios:**

- The Phase 1 dailies bundle declares `create-daily.yaml` with `schedule: "0 6 * * *"` and `idempotent: true`. The workflow internally checks `if (wiki/dailies/<today>.md exists) return no-op`. A user off for three days reconciles, the hook fires once (per clamp), the workflow creates today's daily (the other two days stay un-created — the v0.5 backfill path is to invoke the creator hook manually for each missed date via `dome run-hook dailies:create-daily --event.payload-json='{"date":"<YYYY-MM-DD>"}'`).

- A `nightly-export` hook with `schedule: "0 2 * * *"` and `idempotent: false`. A user off for a week reconciles, the hook skips all seven nights (per `idempotent: false` semantic for scheduled hooks). The exports for those nights are lost — which is fine because exports are non-idempotent side effects that shouldn't be silently re-fired.

- A workflow author writes a `weekly-rollup` hook with `schedule: "0 18 * * 0"` and forgets the internal guard. A user reconciles after two weeks offline; the hook fires once (per clamp), the workflow writes the rollup for the most-recent week, the prior week is missed. The author notices and either adds the internal guard (no-op if rollup exists for week) or accepts the lossy-on-catch-up semantic.

**Related:**

- [[wiki/specs/hooks]] §"Adding a new hook" — the Schedule-driven hook form.
- [[wiki/specs/hooks]] §"The idempotency contract" — the broader contract scheduled hooks specialize.
- [[wiki/specs/hooks]] §"The three reconciliation phases" — Phase 3 scheduled-catch-up semantics.
- [[wiki/gotchas/hook-non-idempotent]] — sibling gotcha; event-reactive hooks have the same shape with different defaults.
