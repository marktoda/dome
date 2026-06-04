---
type: brainstorm
tags:
  - v1
  - automation
  - task-lifecycle
  - llm
  - design-memo
  - work-vault
created: 2026-06-03
updated: 2026-06-03
status: draft
sources:
  - "[[v1]]"
  - "[[VISION]]"
  - "[[cohesive/brainstorms/2026-06-01-dome-v1-automation-first-design-memo]]"
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
  - "[[wiki/concepts/llm-wiki-pattern]]"
---

# Task lifecycle and LLM wardens — evaluation + corrected contract

This memo evaluates a design proposal that came out of a V1 dogfood session on
2026-06-03 (a full day operating the `work` vault through a foreground Claude
Code agent). The proposal: keep a small **deterministic skeleton** for task
hygiene (identity, move, close, normalize) and wrap it in a few broad **LLM
"wardens"** running in the garden phase (read-for-meaning, propose-with-
confidence, escalate people-judgment).

The proposal's diagnosis and central axis are sound. This memo records the parts
that hold, the one mechanism that collides with an axiom, and the corrections
that land the ambition *inside* the invariants Dome has already committed to. It
is design discussion, not a final engineering spec.

## TL;DR

- **A "warden" is not a new primitive. It is a processor.** Specifically:
  `kind: "llm"`, `phase: "garden"`, granted `model.invoke` +
  `question.ask`/`graph.write`, and deliberately **not** `patch.auto`. "Warden"
  is a role-name for that shape, like "linter" or "operator" — the four-concept
  core (Vault, Proposal, Processor, Effect) stays sealed. See
  [[wiki/specs/sdk-surface]] §"Outputs the SDK does not have."
- **The determinism/judgment split is the right cut.** Hashes for what is
  *structurally* true; LLM judgment for what *reading-with-meaning* reveals.
- **The one real collision:** memoizing a model call and recording its output as
  a durable `fact` in `projection.db` breaks
  [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]]. Fix: the model's judgment is
  **transient** (regenerated on schedule); only the human/agent **resolution** is
  durable, and resolutions already rehydrate from `answers.db` on rebuild. This
  makes the proposal *smaller*, not bigger.
- **Identity keystone:** prefer explicit `^block-id` written into markdown over a
  body-hash. Hash-based identity trades a path-collision for a body-collision and
  reintroduces nondeterminism at the one layer that can't afford it.
- **Past dailies are append-only journals:** close-in-place with a tombstone;
  do not delete-and-move (it rewrites history and perturbs the git-date freshness
  rank the open-loop surfacer depends on).
- **Knowledge-touching wardens propose; they do not auto-apply.** Not because
  auto-apply breaks rebuildability — it doesn't — but because pairing
  `model.invoke` + `patch.auto` is exactly the combination the capability split
  exists to keep apart.

## What's grounded in the code

The diagnosis was verified against source, not taken on faith:

- **Task identity is path-scoped.** `openLoopStableId`
  (`assets/extensions/dome.daily/processors/daily-shared.ts:501`) hashes
  `[normalizeSourcePath(path), normalizeOpenLoopBody(body)]`. The same logical
  task copied into four daily notes is four different IDs — nothing can dedup,
  move, or co-close it. Real.
- **`carry-forward` is a read-only aggregator** with a 12-item freshness cap
  (`rankDailyOpenLoopSurfaceItems`, limit 12). Old hand-typed daily tasks are
  indexed as facts but fall below the fold and are never closed. Real.
- **`model.invoke` is already barred from the adoption phase** by design
  (`src/core/processor.ts:214`: "never granted to adoption phase"). The proposal's
  "wardens run in garden, adoption stays deterministic" is not a new constraint —
  it leans on a line the engine already drew. See
  [[wiki/specs/capabilities]] and [[wiki/specs/processor-execution]].
- **`raw-immutable` only guards `raw/` paths** (`isRawPath`), not `notes/**`. So
  the move-tasks-out-of-dailies mechanism is not fenced out by it — the objection
  to it is semantic (below), not a capability block.

## The architectural principle (kept)

> Determinism for what is *structurally* true; LLM judgment for what
> *reading-with-meaning* reveals.

A hash knows two tasks are identical. Only a reader knows a promotion is
mischaracterized, a task is effectively abandoned, or a claim is
self-corroborating. The deterministic processors are the **floor** (idempotent,
auditable, can't drift). The LLM wardens are the **ceiling** (open-ended
coverage). The mistake is making either do the other's job.

| Concern | Side |
|---|---|
| Task identity, dedup, move-forward, close-siblings | Deterministic |
| Frontmatter / wikilink / index / task-syntax normalization | Deterministic |
| "Is this fact stale / mischaracterized / contradictory / under-sourced?" | LLM warden |
| "Is this task actually done, given context?" | LLM warden |
| Tactical vs durable routing | LLM warden |
| Anything touching people / management | LLM warden, `owner-needed` |

## The one real collision: model judgment is not a rebuildable fact

The proposal's mechanism — *ledger-memoize the model call; the output becomes a
recorded fact with provenance, preserving rebuildable projections* — does not
preserve rebuildability as the axiom defines it.

[[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]] (tier: axiom) says facts rebuild
from "running adoption-phase processors plus **explicitly deterministic,
projection-safe garden emitters** against the adopted commit," and explicitly
excludes the run ledger (`runs.db`) from the rebuild guarantee. Its own
counter-example is essentially the warden: "a processor that emits non-idempotent
facts … breaks this invariant." An LLM call is the canonical non-idempotent
emitter.

So a `dome.integrity.assertion_tier` **fact** written into `projection.db` is the
problem. `dome rebuild` re-runs deterministic garden emitters against the adopted
commit and rehydrates `answers.db` — it does not replay ledger memos, and can't
without making `runs.db` a rebuild dependency the axiom forbids. On rebuild the
warden's facts either vanish or require a nondeterministic re-call.

### The fix (which shrinks the design)

Split the warden's output into two layers:

- **The model's judgment is transient.** It is a *suggestion*, regenerated each
  scheduled run. It is never a durable rebuildable fact, so there is nothing to
  make idempotent and no axiom to violate. Ledger-memoize the call **as a cost
  optimization** (skip re-calling on an unchanged span), but do not treat the memo
  as a rebuild source.
- **The human/agent resolution is durable** — and `answers.db` is *already*
  rehydrated on rebuild. A confirmed/dismissed integrity flag survives rebuild for
  free, through the machinery [[wiki/specs/run-ledger]] and the
  `dome.question.continuity` loop already run.

Net: the durable artifact is the *resolution*, not the *inference*. This dissolves
the memoize-as-rebuild-source apparatus entirely and reuses the existing
question/answer path. It is the correction that makes the warden pattern
admissible at all.

## Identity keystone: `^block-id`, not body-hash

`hash(normalizedBody)` trades a path-collision for a body-collision — "Follow up
with Alex" appears verbatim in twenty places and collapses to one logical task.
Salting by linked entity is fuzzy and reintroduces nondeterminism at the identity
layer, the one place it cannot live.

Prefer explicit Obsidian-style `^block-id` written into the markdown. This makes
identity **canonical state**, not a derived hash — the more
[[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]]-aligned choice. It survives both
moves *and* body edits, and it cannot collide. The cost is one deterministic
mechanical processor that stamps a `^id` on first sight (a clean, idempotent
`patch.auto`). Everything in the deterministic skeleton depends on stable
identity; a hash-based identity will quietly mis-merge in ways that are very hard
to debug later. Build this first.

## Past dailies are append-only journals

`raw-immutable` does not block rewriting `notes/**`, so "move, don't copy" is
mechanically possible — but it is a semantic decision that hasn't been named.
Rewriting a daily note dated months ago:

1. mutates its git-modified date, which is the **input to the freshness rank**
   the open-loop surfacer sorts on; and
2. destroys "what I thought on that day."

Decision: treat past dailies as **append-only journals**. The durable home for a
live task is a wiki page (or today's note). The operation is **close-in-place
with a tombstone** in the origin daily, and *surface* the canonical instance
elsewhere — never delete-from-origin. Tombstoning is the right instinct; apply it
to closure, not relocation.

## Auto-apply: separate two properties

The proposal leaves a door open for `model-safe` high-confidence patches to
auto-apply, while also saying wardens don't rewrite knowledge. Resolve via a
distinction:

- **Auto-applied model *content* patches are not a rebuildability violation.**
  Once committed, the markdown is canonical and rebuild walks the adopted commit.
  A warden auto-committing is formally "another writer," like a human or agent
  running `Write` + `git commit` — which Dome already tolerates.
- **What you lose is trust/auditability, not an invariant.** So it is a *policy*
  call: default knowledge-touching wardens to **propose-only**. The
  `question` → `dome resolve` → deterministic-apply path is barely slower and keeps
  a human/agent gate on meaning-shaped edits. Reserve `patch.auto` for the
  deterministic hands acting on structural identity.

Close the model-safe-auto-apply door for knowledge content — not because it
breaks an axiom, but because `model.invoke` + `patch.auto` is the pairing the
capability split was designed to keep apart. See [[wiki/specs/effects]]
(`automationPolicy: agent-safe | model-safe | owner-needed`).

## Smaller flags

- **A mandate version is a processor version.** Memo keys include
  `mandateVersion`; bumping a charter prompt invalidates every memo → full
  re-evaluation → cost spike and a churn of re-raised flags. This is
  [[wiki/gotchas/processor-version-drift]] applied to prose. Version mandates
  deliberately; budget for the re-evaluation.
- **The deterministic contradiction pre-filter is the best cheap win.** Same
  `(entity, attribute)` asserted with different values across pages → a
  rebuildable, fast diagnostic that hands the integrity warden a *shortlist* and
  bounds its context recipe before any model runs.
- **Settlement by content-hash** (re-raise a flag only when its span changes)
  mirrors `settledSourceBackedOpenLoops` in `carry-forward` and is the right
  re-entrancy guard. Keep it; it is independent of the rebuildability fix above.

## Sequencing

1. **Explicit `^block-id` identity + the stamping processor.** The true keystone;
   body-hash will mis-merge.
2. **`task-reconcile` as close-in-place + dedup-to-canonical** (not
   move-from-origin). Kills the manual janitoring; respects journal semantics.
3. **Integrity warden — questions/resolutions only, no durable model-facts.** The
   reference implementation of the corrected pattern; catches the class of bug the
   dogfood day hit (a completed promotion recorded as outstanding, a self-
   corroborating "per wiki" citation, an agent-invented level label hardened into
   fact).
4. **Daily-briefing warden.** High value, but it *reads* the above; downstream.

Defer `model-safe` auto-apply indefinitely; let the propose → resolve path prove
itself first.

## Open questions

- Where does the `^block-id` stamp run — adoption (mechanical, instant) or garden?
  Adoption keeps identity assigned before any garden warden reads it, but adds a
  `patch.auto` writer to the fixed-point loop; check it converges cleanly against
  [[wiki/gotchas/processor-fixed-point-divergence]].
- Does the integrity warden's transient-suggestion model need a projection table
  at all, or can it live entirely as open questions until resolved? If the daily
  briefing wants to *show* unconfirmed inferences, a transient (rebuild-dropped)
  projection row may be justified — but it must be clearly marked non-durable.
- People/management `owner-needed` routing: is "page typed `entity` about a
  person, or `notes/**` management content" a reliable enough deterministic
  pre-classifier to choose the policy, or does that classification itself need a
  warden?
