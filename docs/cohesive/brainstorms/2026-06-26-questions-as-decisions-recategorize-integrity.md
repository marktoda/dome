# Questions are decisions: recategorize integrity findings as diagnostics

**Date:** 2026-06-26
**Status:** design, approved direction — ready for implementation plan
**Scope:** `dome.warden.integrity` output channel; the question-vs-diagnostic contract.
**Supersedes the need for:** a "triage surface" for the owner-needed question backlog (the backlog is a categorization failure, not a presentation one).

## The trigger

A dogfood session flagged the owner-needed question backlog growing unbounded
(`dome check`: 57 open, 50 owner-needed) with no way to triage it. The first
instinct was to build a triage/legibility view. Pressure-testing the framework
from first principles against live data killed that premise.

## What the work vault actually shows

Read-only query of `/Users/mark.toda/vaults/work/.dome/state/projection.db`:

- **80 open questions; exactly 1 has ever been answered.** The
  resolve → answer-handler → effect loop — the entire *point* of a question —
  is dead in practice.
- **76 of 80 (95%) come from one processor: `dome.warden.integrity`** (61
  owner-needed + 15 agent-safe). Their texts are findings:
  *"Integrity flag in wiki/entities/damir.md: a completed/historical event is
  framed as ongoing"*, *"an internal or cross-page contradiction."*
- **Answering an integrity question does nothing.** `integrity-answer.ts` is a
  terminal no-op (emits an `info` diagnostic, never a patch or fact; its own
  header documents this is "TERMINAL by design"). So they are diagnostics
  wearing a question costume.
- **15 are tagged `agent-safe`** — "a machine can clear this" — yet sit open;
  the auto-resolution path that was meant to drain them is dormant.
- The genuinely owner-shaped decisions are ~17, drowned ~4:1:
  `stale-task-warden` (archive/reschedule/delete, ×8 — real, answerable) and
  `sweep` (×9, several of which are "this page is too big, you do it").
- The personal vault has ~0 questions. This is a work-vault firehose, and it is
  the integrity warden.

This is precisely the anti-pattern the v1 automation-first memo warned against
(`docs/cohesive/brainstorms/2026-06-01-dome-v1-automation-first-design-memo.md`):
> Bad V1 signs: Dome mostly tells Mark what is wrong. `dome check` becomes the
> primary product surface. Mark has to manually resolve a long queue of obvious
> questions.

And the effects spec already says diagnostics "are never part of the questions
surface." The framework drifted from its own design.

## The reframe

Route by **what answering does**, not by who emits:

- A **question** is a decision that, once answered, **unlocks an action**. The
  answer-handler does something.
- A **diagnostic** is a finding the owner/agent might fix by editing. It
  self-clears when the content improves. No resolve action.
- A **task** is work to do.

If answering a "question" does nothing, it was never a question. Every integrity
flag today fails this test. The fix is to move it to the right bucket — not to
build a view that prettifies the wrong one.

This is *more* faithful to the wardens' "propose-not-auto" principle
(`2026-06-03-dome-task-lifecycle-and-llm-wardens.md`), not a retreat from it: the
model still never patches (the `model.invoke` + `patch.auto` pairing the
capability split exists to keep apart). It surfaces a finding; a human or the
foreground agent edits; the diagnostic clears. The dead-handler question was a
broken middle ground — neither a real proposal (answering did nothing) nor a
diagnostic.

## Design

### Core change: `dome.warden.integrity` emits diagnostics, not questions

In `assets/extensions/dome.warden/processors/integrity.ts`, both emit sites —
the deterministic claim-collisions and the filtered model findings — emit
`diagnosticEffect` instead of `questionEffect`.

- **Message:** the existing finding text, plus the suggested fix currently
  carried as `recommendedAnswer` (e.g. "reconcile to the 2026-06-17 value")
  folded into the diagnostic message.
- **Severity (risk-mapped):** `high` risk → `warning`; everything else → `info`.
  Per `src/surface/status.ts`, `info` diagnostics are visible but never route
  `attention_required`; `warning` routes attention but as a scannable,
  self-clearing diagnostic — not a resolve-me queue. So hard/high-confidence
  contradictions stay actionable; the soft model tail stays quiet. Never
  `error`/`block` (these findings must not gate adoption).
- **Identity / settlement:** diagnostics carry no `idempotencyKey`; their
  settlement identity is `code` + `diagnosticSubjectHash` (subject derived from
  the message/sourceRefs). Assign a stable `code` per finding kind (e.g.
  `dome.warden.integrity.contradiction`, `.stale-framing`) so
  `resolveStaleDiagnostics` (`src/projections/diagnostics.ts:311`, wired in
  `src/projections/sinks.ts:178`) clears a finding when the warden re-inspects
  the page and no longer emits that `(code, subject)`. The warden already runs
  in the inspected-paths model that drove `resolveStaleQuestions`, so the
  self-clear-on-reconcile behavior carries over directly — just on the
  diagnostics surface.
- **Capability:** swap the manifest grant `question.ask` → `diagnostic.write`
  for the integrity processor (keep `model.invoke`).

### Retire `integrity-answer.ts`

It is the terminal no-op answer handler — dead once integrity stops emitting
questions. Remove the processor file, its manifest entry, and its AC3/test
lockstep.

### Net effect

~76 of 80 open items leave the owner's decision queue and become self-clearing
health diagnostics (mostly `info`, a few `warning`) that the owner or the
foreground agent fixes through normal editing. The owner-facing **question**
queue drops to ~17 genuinely actionable decisions (sweep integrations,
stale-task settlements, health recovery), each with a handler that acts on
answer. No triage view is required: a short list of self-clearing, actionable
decisions manages itself.

## Scope boundaries

**In scope:** the integrity warden's output channel + retiring its dead handler.

**Flagged as fast-follows, NOT this change:**
- **Auto-resolution path** (`src/engine/operational/question-auto-resolution.ts`)
  is dormant; once integrity is diagnostics there are no `agent-safe` questions
  left to resolve in practice. Leave it; assess separately (revive vs delete).
- **Sweep size-guard escalations** ("page too big, you do it", options
  `[skip]`) are also diagnostic-shaped — a single-option "question" is an
  acknowledgment. Small follow-up to demote; not part of this change.

## Testing

- Integrity-warden unit test: asserts it emits `diagnosticEffect` (not
  `questionEffect`) for both collision and model findings; severity maps
  `high→warning`, else `info`; a reconciled page stops emitting (self-clear).
- Delete the `integrity-answer` test; update the AC3 invariant/lockstep that
  pins the answer handler.
- Confirm the other question emitters (sweep, stale-task-warden, health
  recovery) are untouched and still emit questions.

## Acceptance criteria

1. `dome.warden.integrity` emits no `QuestionEffect`; all findings are
   `DiagnosticEffect` with risk-mapped severity and content-hash identity.
2. `integrity-answer` and its lockstep are removed; the suite is green.
3. On the work vault after rebuild, the open-question count drops to the
   non-integrity emitters (~a dozen), and integrity findings appear as
   self-clearing diagnostics.
