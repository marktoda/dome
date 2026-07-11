---
type: spec
tags:
  - attention
  - decisions
  - proposals
created: 2026-07-09
updated: 2026-07-11
status: shipped
---

# Owner attention

Owner attention is a protocol-neutral **derived view**, not an Effect kind,
store, workflow primitive, or plugin category. The implementation is
`src/attention/attention.ts`; its one interface is `compileAttention`, exposed
to consumers as `Vault.attention()` and the `dome.attention/v1` document.

## Inputs

Only two durable request kinds enter the owner queue:

1. open `QuestionEffect` rows whose `automationPolicy` is `owner-needed` (or
   omitted for conservative compatibility); and
2. pending garden `PatchEffect { mode: "propose" }` rows.

Diagnostics do not enter the queue: they are findings with self-clearing or
source-repair settlement. Tasks do not enter the queue: markdown already owns
their lifecycle, and daily/task views derive their current state directly.
Engine health does not enter the queue: status/check report it separately.
Agent-safe questions are counted as agent work and never spend the
owner's budget.

## Output and ranking

`AttentionSnapshot` contains a bounded `primary` list (default 3), a `backlog`,
an `agentWorkCount`, and exact counts. Decisions and reviews compete in one
order and one budget. The rank is an explainable tuple:

1. urgency (`now`, `soon`, `none`);
2. consequence (`high`, `medium`, `low`);
3. confidence;
4. freshness; and
5. stable id.

No opaque numeric score is exposed. Ordinary non-urgent requests older than
`DEFAULT_ATTENTION_AGING_DAYS` (7) move to backlog. High-consequence or urgent
requests remain primary-eligible regardless of age. Stale proposals are
backlog until regenerated.

Question producers may supply `metadata.attention { consequence, urgency,
reason, dueAt }`. Missing hints degrade conservatively to medium consequence,
no urgency. Proposal review hints are not yet carried by PatchEffect, so a
concrete diff defaults to medium consequence and known framing.

## Decision semantics

A real question has a response with defined consequences. First-party
producers declare `metadata.resolutionMode`:

- `dispatch` — a matching answer-triggered processor applies the transition;
- `acknowledge` — recording the answer is itself the terminal transition.

Generic agent-loop `askOwner` has no resumable continuation, so it emits a
source-backed diagnostic rather than an inert QuestionEffect. Oversize input,
ungrounded prose, and stale tasks are likewise not decisions. Stale tasks stay
as markdown tasks and are reviewed/settled directly; Dome does not duplicate
them into persistent questions.

The retired metadata-only auto-resolution pump never inspected semantic vault
evidence: it accepted a recommended answer when referenced files merely still
existed. Agent-assigned questions are now resolved by an actual vault-aware
foreground/background agent through [[wiki/specs/agent-work]], which requires
current packet revision, inspected SourceRefs, and an audit reason before the
normal durable resolve operation.

## Plugin contract

Plugins do not register attention providers or cadence categories. They use
the existing four-concept system:

- emit `QuestionEffect` for a genuine decision;
- emit propose-mode `PatchEffect` for reviewable edits;
- emit `DiagnosticEffect` for findings;
- keep domain work in facts/views/markdown.

The compiled daily, live Today view, status, check, HTTP, MCP, and PWA all
consume the same attention compiler. A new owner action kind therefore needs a
deliberate typed adapter and action path; arbitrary plugin JSON cannot create
an unexecutable mobile card.

## Related

- [[wiki/invariants/ATTENTION_IS_DERIVED]]
- [[wiki/specs/effects]]
- [[wiki/specs/daily-surface]]
- [[wiki/specs/sdk-surface]]
- [[wiki/concepts/client-model]]
