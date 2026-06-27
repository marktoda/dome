# Sweep escalations are diagnostics, not questions

**Date:** 2026-06-27
**Status:** design, approved — ready for implementation plan
**Scope:** `dome.agent.sweep`'s three `escalate:`-type emit sites + the dead `escalate` branch of `dome.agent.sweep-answer`.
**Continues:** [[2026-06-26-questions-as-decisions-recategorize-integrity]] — the same "a question's answer must unlock an action" principle, applied to the #2 owner-question source.

## The trigger

After the integrity warden was reclassified, sweep became the largest remaining
owner-question emitter. Of its questions, the `escalate:`-type ones are notices,
not decisions: they offer only `["skip"]`, and the `escalate` branch of
`sweep-answer.ts` is a literal `return []` no-op (same dead-handler pattern
integrity had). The durable settlement lives entirely in the **sweep ledger**,
not the question.

## Lifecycle (the load-bearing facts)

- A pair that hits a threshold emits one escalate question **and** writes a
  ledger row (`escalated` for the failure threshold; `questioned` for the two
  size guards). The row settles the pair: `sweep-queue.ts` `ledgerInfo` marks
  it `settled`, and queue build does `if (li.settled) continue` — so the pair
  is **excluded from all future queue builds**. Sweep never re-processes it, so
  it never re-emits. The question is emitted exactly once and persists.
- Re-arm is **deliberately manual**: the owner hand-deletes the `escalated`/
  `questioned` row from the ledger; the pair re-enters the queue next run.
- Answering the escalate question does nothing (`sweep-answer.ts` returns `[]`
  for the `escalate` namespace). The ledger row — written at emit time — is the
  only durable state.

So the escalate question is a *notice over a ledger row*. The `uncertain→
integrate` question is different: it offers `["integrate","skip"]`, carries the
model's `proposedSection`, and answering `"integrate"` emits a real patch. That
one stays a question.

## Design

### 1. `sweep.ts` — the three escalate emit sites emit diagnostics

The failure-threshold, destination-too-large, and material-too-large sites swap
`questionEffect` → `diagnosticEffect`:

- `severity: "warning"` (all three) — these are un-integrated captures needing
  manual action; warning keeps "no capture left behind" honest without a
  dead-end resolve step.
- Stable `code` per reason (one reason fires per pair per run): `dome.agent.sweep.escalate-failures`, `dome.agent.sweep.dest-too-large`,
  `dome.agent.sweep.material-too-large`.
- `message`: the existing text, reframed from a question to a statement — drop
  "integrate manually or skip?" and state the consequence, e.g. "…; integrate
  it manually, or it stays unswept until you re-arm the pair by deleting its
  ledger row."
- `sourceRefs: itemRefs` (the `[material, destination]` pair) — **unchanged**.
  Two escalated pairs sharing a destination stay distinct (different material →
  different subject-hash), so the projection's `INSERT OR IGNORE` dedup keeps
  both (same per-subject distinctness the integrity collision/finding fix
  relied on).
- Drop the diagnostic-irrelevant fields: `options`, `idempotencyKey`,
  `metadata.automationPolicy`. Diagnostics are ungated and carry no policy.

**Unchanged:** each site still does its `ledgerRows.push({ ...row, disposition:
"escalated" | "questioned" })` then `continue`. The ledger writes are the
durable settlement and the queue-exclusion contract — this change touches only
the owner-facing *surface*.

### 2. `sweep-answer.ts` — remove the dead escalate branch

Delete the `if (keyKind === "escalate") return [];` no-op, the `ESCALATE_PREFIX`
constant, and the `"escalate"` arm of `discriminateKey` (now `uncertain` |
`unknown`). The `uncertain` integrate/skip handling and the handler's
`dome.agent.sweep:`-prefix trigger stay. A stray pre-migration escalate answer
would fall through to `unknown` → `[]` — same no-op, no harm.

### 3. Capability — no change

`dome.agent.sweep` keeps `question.ask` (the `uncertain→integrate` question
still needs it). Diagnostics are ungated, so no grant is added or removed.

### 4. Self-clear — inherent, no code

The escalate diagnostic persists exactly as the question does today.
`resolveStaleDiagnostics` and `resolveStaleQuestions` share one predicate
(prior row's sourceRefs touch the processor's `inspectedPaths` AND not
re-emitted this run), over the same processor and the same `[material,
destination]` sourceRefs. Since the escalate *question* is never wrongly
stale-cleared today (it persists until re-arm), a diagnostic with identical
sourceRefs and processor persists identically. When the owner hand-deletes the
ledger row, the pair re-enters the queue; on re-processing, if it integrates or
no-ops the diagnostic is not re-emitted (and the path IS inspected that run) so
`resolveStaleDiagnostics` clears it; if it re-escalates it re-emits and stays.

### 5. Normative-doc sweep

Update the wiki pages that describe sweep's escalations as *questions* —
primarily `docs/wiki/specs/sweep.md`, and the bundle matrices
(`extension-bundle-shape.md`, `built-in-extensions-x-phase.md`) if they name an
`escalate` question/answer. The plan greps `docs/wiki/` for stragglers.
Historical brainstorms/plans stay.

## Explicitly NOT in scope

- The sweep ledger / settlement model, the queue-exclusion logic, and the
  manual re-arm-by-hand-delete contract — all unchanged.
- The `uncertain→integrate` question and its `sweep-answer` integrate handler —
  untouched.
- The `sweepIdempotencyKey("escalate", …)` helper arm becomes uncalled; leave
  it (harmless) rather than reshape the helper.

## Testing

- `sweep.test.ts`: each escalate site emits a `warning` `DiagnosticEffect` with
  the right `code`, a statement-shaped message, and `[material, destination]`
  sourceRefs — and emits **no** `QuestionEffect` for those cases; two escalated
  pairs on one destination yield two distinct diagnostics. The `uncertain` path
  still emits a `QuestionEffect` with `["integrate","skip"]`.
- `sweep-answer.test.ts`: the `uncertain` integrate/skip behavior is unchanged;
  the escalate-branch tests are removed (the branch is gone).

## Acceptance criteria

1. The three escalate sites emit `warning` diagnostics (distinct codes), not
   questions; the `uncertain→integrate` question is unchanged.
2. `sweep-answer.ts` has no `escalate` branch / `ESCALATE_PREFIX`; the suite is
   green.
3. Ledger dispositions and queue exclusion are byte-for-byte unchanged.
4. `docs/wiki/` no longer describes sweep escalations as questions.
