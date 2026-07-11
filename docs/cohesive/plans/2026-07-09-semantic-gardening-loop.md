# Semantic gardening loop refactor

**Date:** 2026-07-09
**Status:** complete
**Normative design:** [[wiki/specs/semantic-gardening]]

## Mission

Collapse three partially overlapping maintenance pipelines into a single
semantic-gardening module with an explicit contract: deterministic opportunity
compilation, bounded model investigation, and proposal-only output.

## Hard cuts

- Retire `dome.agent.consolidate`, `dome.agent.sweep`,
  `dome.agent.sweep-answer`, and `dome.agent.patrol`.
- Delete their charters, tools, cursors, ledgers, queues, answer continuation,
  and maintenance-loop declarations.
- Remove sweep-ledger coupling from the morning brief and daily renderer.
- Replace `consolidate_targets` / `sweep_targets` with `garden_targets`, and
  replace model overrides `consolidate` / `sweep` with `garden`.

## New module

- `lib/gardening.ts`: pure `compileGardeningPlan` interface.
- `processors/garden.ts`: scheduled model adapter, one opportunity, proposed
  edits only.
- `processors/garden-view.ts`: command-triggered read adapter.
- Existing proposal rows settle exact opportunity ids; changed evidence re-arms
  review.

## Verification

- Pure compiler tests cover ranking, stale claims, oversized pages, duplicate
  evidence, material integration, orphans, rotation, and proposal settlement.
- Processor tests prove no model on an empty plan, proposal-only edits, atomic
  rollback, caps, and settled-proposal suppression.
- Manifest/default-config tests pin the one-processor/one-view shape and the
  absence of retired meta files.
