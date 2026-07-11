---
type: spec
created: 2026-07-09
updated: 2026-07-11
description: One proposal-only semantic-gardening module that compiles vault evidence into bounded opportunities without queues or maintenance ledgers
---

# Semantic gardening

Semantic gardening is the loop that keeps adopted markdown coherent as the
vault grows. It replaces the former `consolidate`, `sweep`, and `patrol`
pipelines with one deep module and two thin adapters.

## Product contract

```text
adopted markdown + git file recency + proposal decisions
  -> compileGardeningPlan(...)
  -> one bounded, evidence-backed opportunity
  -> dome.agent.garden investigates with direct markdown tools
  -> PatchEffect(mode: "propose")
  -> owner applies or rejects through the normal proposal lifecycle
```

The module owns selection, prioritization, coverage rotation, and the result
schema. The scheduled processor owns model execution. The `garden` view owns
read-only presentation. Neither adapter invents a second queue or state
machine.

The compiler currently notices recent material that may need integration,
possible duplicate pages, conflicting or stale dated claims, oversized pages,
orphans, and a small date-salted rotation sample. These `kind` values are
private hints inside `dome.agent`; they are not plugin categories and are not
added to the four-concept core.

Recent material is source-centered: one opportunity groups up to eight
explicitly linked destination pages from one daily or processed capture. This
keeps a single source investigation coherent without turning every
source/destination pair into queue-shaped noise. Duplicate candidates must
share a distinctive normalized title identity in addition to description
similarity, so generic template vocabulary does not manufacture conflicts.

## Memory and settlement

There is no `meta/consolidation-ledger.md`, `meta/sweep-ledger.md`, patrol
queue, patrol ledger, cursor, or answer-continuation state.

An opportunity id hashes its kind, paths, and current evidence. The proposal
store retains pending, applied, and rejected decisions. `dome.agent.garden`
reads those rows and suppresses an
exact settled opportunity. When relevant markdown evidence changes, the hash
changes and review can re-arm. Git history remains the activity log.

This makes the proposal lifecycle the module's durable memory instead of
creating a second maintenance registry beside it.

## Safety posture

- Selection is deterministic and model-free.
- A nightly run investigates exactly one opportunity and may touch at most 30
  files.
- Semantic changes always use `patch.propose`; garden never auto-applies them.
- A clean bill is a successful zero-patch run.
- Direct markdown tools remain the agent interface. The compiler narrows what
  deserves attention; it does not replace flexible vault access.
- Deterministic syntax repair remains in the bundles that own those
  conventions. Semantic garden does not absorb lint or formatting work.

## Surfaces

`dome garden` invokes the command-triggered `dome.agent.garden-view` processor
and returns `dome.agent.garden/v1`: total semantic pages, total unresolved
opportunities, counts by private kind, and up to 20 ranked opportunities with
source paths and evidence. Mobile, MCP, HTTP, and agent hosts can invoke the
same installed view through the shared view operation; no protocol-specific
gardening engine exists.

Third-party plugins continue to contribute arbitrary processors, effects, and
views. They do not register into a fixed “daily/weekly/gardening” taxonomy.
They can expose their own maintenance views or emit ordinary proposals, and
the existing owner-attention surface will compose those proposal reviews.

## Coherence measure

The unresolved opportunity count is the honest current measure. Applying a
useful proposal should remove or change its evidence; rejecting it settles
that exact evidence. The run ledger supplies cost and outcome history, while
the proposal store supplies accept/reject history. No score is persisted into
markdown or projection state.

`bun run eval:product --vault <path>` compiles the retained
`dome.agent.garden` proposal rows into an observational quality report. It
includes pending attention load, owner applies and rejects, expired rows,
decision latency, line/file edit size, per-opportunity-kind outcomes, and
changed-evidence recurrence. Owner apply rate is a usefulness proxy, not
ground-truth opportunity precision. It is `null` when there are no human
decisions, and no release threshold is set until the vault has at least 20
human-decided semantic-garden proposals. The report reads the existing
proposal lifecycle; it does not add a queue or evaluation ledger.
