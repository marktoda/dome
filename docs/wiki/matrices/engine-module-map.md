---
type: matrix
created: 2026-06-10
updated: 2026-07-06
sources:
  - "[[cohesive/reviews/2026-06-10-oop-abstraction-layers-architecture-review]]"
description: Maps every src/engine/ module to its layer (core/garden/operational/host) — the placement table the import-direction linter enforces.
---

# Engine module map

The canonical map of `src/engine/`'s internal layering. The engine is one conceptual service (the adoption loop + the single applier per [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]]), but internally it is four layers with a strict downward-only import direction. Each engine module lives in the subdirectory named after its layer; the directory placement *is* the layer assignment.

**Lockstep status:** shipped. `tests/integration/engine-import-direction.test.ts` parses this matrix and asserts (1) every module row exists on disk as either `src/engine/<layer>/<module>.ts` or a `src/engine/<layer>/<module>/` directory (a directory-module, e.g. `health/`), (2) every `.ts` file under `src/engine/` is covered by a row (directly or under a directory-module), and (3) no engine module imports a module from a higher-ranked layer. See [[wiki/linters/engine-import-direction]] for the rule.

## The four layers

Ordered innermost-first. A module may import modules in its own layer or any lower-ranked layer, never higher.

| Rank | Layer | Directory | Role | May import (intra-engine) |
|---|---|---|---|---|
| 0 | **core** | `src/engine/core/` | The adoption loop, effect application, capability machinery, and shared engine contracts. Pure machinery: no daemon, no scheduling, no model-provider wiring. | `core` |
| 1 | **garden** | `src/engine/garden/` | Garden-phase orchestration: patch routing, sub-Proposal construction, run-effect routing. | `garden`, `core` |
| 2 | **operational** | `src/engine/operational/` | Post-adoption operational work: cron scheduling, answers and question lifecycle, quarantine state, operational query views. | `operational`, `garden`, `core` |
| 3 | **host** | `src/engine/host/` | Long-running orchestration and process-level concerns: the compiler host, locks, vault-runtime assembly, projection rebuild lifecycle, view command execution, health probes, model-provider wiring. | any engine layer |

Cycles are permitted *within* a layer (e.g. `apply-effect` ↔ `diagnostics` in core) but never across layers.

## Module → layer

| Module | Layer | Role |
|---|---|---|
| `adopt` | `core` | The fixed-point adoption loop — the engine's entry point |
| `adoption-status` | `core` | Read-only adoption cursor snapshot (cheap git reads, no runtime) |
| `apply-effect` | `core` | The generic effect applier route (the chokepoint behind [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]]) |
| `apply-patch` | `core` | Candidate-tree mutator for adoption-phase PatchEffects |
| `capability-broker` | `core` | The single chokepoint that gates every Effect ([[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]]) |
| `capability-policy` | `core` | Vault config → runtime settings + effective bundle grants |
| `closure-commit` | `core` | Closure-commit construction (Dome-* trailers) |
| `commands` | `core` | View-phase command dispatcher (pure dispatch machinery) |
| `compile-range` | `core` | "What changed in this Proposal" primitive |
| `diagnostics` | `core` | Persisting engine-created diagnostics |
| `diff3` | `core` | Line-level 3-way merge primitive backing garden-patch convergence (see [[wiki/specs/proposals]] §"Garden-emitted Proposals") |
| `effect-capability-use` | `core` | Canonical run-ledger audit labels for effect capability enforcement |
| `finalize-journal` | `core` | Finalize-intent journal — crash-safety for adoption finalization |
| `glob-cache` | `core` | Cached Bun.Glob compilation |
| `model-invoke` | `core` | Provider-neutral `ctx.modelInvoke` seam (types + envelope) |
| `path-capabilities` | `core` | Path-bearing capability helpers |
| `runner-contract` | `core` | Neutral home for the engine's outbound runner contracts |
| `vault-shape` | `core` | EngineVault — the minimal structural shape the engine reads |
| `garden` | `garden` | The garden-phase orchestrator |
| `garden-patch-dispatch` | `garden` | Shared garden PatchEffect dispatch for non-signal garden sources |
| `garden-run` | `garden` | `dispatchGardenRun` — shared snapshot + dispatch + route for one non-signal garden run (schedule / answer) |
| `garden-run-routing` | `garden` | Shared effect routing for one non-signal garden processor run |
| `garden-sub-proposals` | `garden` | Garden PatchEffect → sub-Proposal conversion (cascade-depth bookkeeping) |
| `answers` | `operational` | Dispatch garden-phase processors after a user answer |
| `cron` | `operational` | Minimal 5-field cron expression evaluator |
| `operational-query-view` | `operational` | Read-only operational state for processors |
| `operational-work` | `operational` | One pump for non-adoption engine work |
| `proposal-expiry` | `operational` | Subject-liveness expiry — auto-rejects PENDING garden proposals whose owning processor is retired |
| `quarantine-store` | `operational` | Processor quarantine state store |
| `question-answer-recording` | `operational` | Durable QuestionEffect answer writes |
| `question-auto-resolution` | `operational` | Opt-in background resolution for low-risk questions |
| `question-expiry` | `operational` | Subject-liveness expiry — releases OPEN questions whose subject processor is retired |
| `questions-changed` | `operational` | Dispatch garden-phase `questions.changed` subscribers after the open-question set changes |
| `store-changed` | `operational` | Dispatch garden-phase `outbox.changed` / `quarantine.changed` subscribers after a store's failure set changes |
| `scheduler` | `operational` | Cron-driven processor dispatch |
| `command-model-provider` | `host` | Config-driven model-provider wiring |
| `compiler-host` | `host` | Runtime host operations over an open VaultRuntime (`dome serve`) |
| `compiler-host-heartbeat` | `host` | Host heartbeat file |
| `compiler-host-lock` | `host` | Per-branch runtime host exclusion |
| `file-lock` | `host` | Cross-process exclusive lock helper |
| `health` | `host` | Read-only probes for operational recovery surfaces (a `health/` directory-module of submodules) |
| `model-provider-probe-cache` | `host` | Persisted last-probe result for the model provider |
| `projection-lock` | `host` | Shared exclusion for projection.db writes |
| `projection-rebuild` | `host` | Rebuild projection.db from the adopted commit |
| `question-answering` | `host` | Durable answer orchestration (records the answer, then runs a compiler tick) |
| `vault-runtime` | `host` | The composed v1 runtime handle (stores + providers) |
| `view-command` | `host` | Engine-owned runtime boundary for command-triggered view processors |

## Where new engine modules go

Pick the lowest layer whose "May import" column covers everything the module needs. A module that needs the compiler host or vault-runtime is `host`; a module that only routes effects and patches is `core` or `garden`; cron/question-lifecycle work is `operational`. If a `core`/`garden`/`operational` module finds itself needing an upward import, that is the design signal to either move the module up a layer or extract the shared part downward — not to add the import.

## Related

- [[wiki/linters/engine-import-direction]] — the lint rule + lockstep test enforcing this matrix
- [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]] — why the engine exists as one sealed service
- [[wiki/matrices/extension-bundle-shape]] — the sibling lockstep-matrix pattern this follows
