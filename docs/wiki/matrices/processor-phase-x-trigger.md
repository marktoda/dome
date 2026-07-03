---
type: matrix
created: 2026-05-27
updated: 2026-06-12
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
description: Crosses processor phases with trigger kinds (signal/path/schedule/answer/command) — which pairs the manifest validator allows, and why.
---

# Processor phase × trigger matrix

Maps the three processor phases (adoption / garden / view) to the trigger kinds (signal / path / schedule / answer / command) they may register against. Phase × trigger compatibility is enforced at bundle load by the manifest validator; an incompatible declaration fails bundle load as `manifest-invalid` with a `phase-trigger-mismatch` cause.

## The matrix

| Trigger kind ↓ \ Phase → | adoption | garden | view |
|---|---|---|---|
| **`signal`** — tree-diff-derived (`file.created`, `file.modified`, `file.deleted`, `document.changed`, `frontmatter.changed`, `region.changed`, `link.added`, `link.removed`) and store-change-derived (`questions.changed`, `outbox.changed`, `quarantine.changed`; garden-only in practice — dispatched by the operational channels, not `compileRange`) | ✓ Allowed | ✓ Allowed | ✗ Rejected |
| **`path`** (path glob pattern) | ✓ Allowed | ✓ Allowed | ✗ Rejected |
| **`schedule`** (cron expression) | ✗ Rejected — adoption is per-Proposal, not periodic | ✓ Allowed | ✗ Rejected — scheduled work needs a durable route; use garden |
| **`answer`** (QuestionEffect answer, optionally narrowed by idempotency-key prefix) | ✗ Rejected — answers are user decisions after adoption | ✓ Allowed | ✗ Rejected |
| **`command`** (command name) | ✗ Rejected — adoption isn't user-invoked | ✗ Rejected — garden runs autonomously | ✓ Allowed (`dome query`, `dome export-context`, hidden compatibility/debug wrappers, or `dome run <name>`) |

## Phase semantics recap

- **Adoption** — runs inside the fixed-point loop. Bounded, deterministic, merge-blocking. Subscribes to per-Proposal signals computed from the candidate-tree diff. Never invoked by cron or user command (it runs because a Proposal is being adopted).
- **Garden** — runs async on adopted state. May be slow; may call LLMs. Triggered by signals (e.g., post-adoption "new entity page appeared"), paths, cron schedules, or answered questions. Not user-invoked directly — the engine schedules garden runs.
- **View** — runs on demand for queries / CLI commands / MCP `dome.run_command`. Read-only; renders responses from adopted state + projections. It does not run on cron in v1 because scheduled view output has no caller-owned delivery surface.

## Why each rejection

| Rejection | Reason |
|---|---|
| adoption × schedule | Adoption is per-Proposal — the adoption loop doesn't have a "next cron tick" semantic. A processor that wants periodic execution lives in garden phase. |
| adoption × command | Same — adoption runs because a Proposal needs adopting, not because a user typed `dome <name>`. A view-phase processor handles command invocations; if a command needs to cause writes, it should enqueue or ask for garden-phase work rather than emit PatchEffects directly. |
| adoption × answer | Answers arrive after a question row exists in adopted-state operational substrate; handling them belongs in garden. |
| garden × command | Garden runs are scheduled by the engine, not the user. A user-invokable operation is view-phase; writes belong behind garden/adoption routing, not direct command-triggered patches. |
| view × signal / path / answer | Views render on demand, not on writes or user-decision events. A processor that reacts to a vault write or answer is adoption-phase or garden-phase. |
| view × schedule | Scheduled work has no interactive caller waiting for a ViewEffect. A periodic report that must be persisted, queued, or externalized belongs in garden and emits the appropriate durable effect. |

## How the validator catches mismatches

`src/extensions/manifest-schema.ts` validates manifest declarations against this matrix:

```ts
function validateProcessorDeclaration(decl: ProcessorDeclaration): Result<void, ManifestError> {
  for (const trigger of decl.triggers) {
    if (!ALLOWED[decl.phase].has(trigger.kind)) {
      return err({
        kind: "phase-trigger-mismatch",
        processorId: decl.id,
        phase: decl.phase,
        trigger: trigger.kind,
      });
    }
  }
  return ok(undefined);
}
```

The implementation uses a hardcoded mirror in `src/extensions/manifest-schema.ts`
(`ALLOWED_TRIGGERS_BY_PHASE`) and loader/manifest tests cover representative
rejections. A future doc-driven lockstep test should compare that mirror
against this matrix directly.

## Implementation status

**As of the current v1 roadmap work:**

The phase × trigger matrix is **the canonical contract** that the manifest validator enforces. The type-system fences at the `Trigger` and `ProcessorPhase` level are real, and `src/extensions/manifest-schema.ts` rejects incompatible per-processor declarations during bundle load.

- Structurally true now:
  - The closed `Trigger` discriminated union in `src/core/processor.ts` enforces the five trigger kinds at the type system level, including `{ kind: "answer"; questionProcessorId?: string; idempotencyKeyPrefix?: string }`.
  - The closed `ProcessorPhase` literal-union enforces the three phases.
  - `src/processors/triggers.ts:matchTriggers` consumes `signal` and `path` triggers; `schedule`, `answer`, and `command` triggers return no match because each has a dedicated dispatcher.
  - **Adoption-phase runner** (`adoptionRunner` in `src/processors/runtime.ts`) — operational since Phase 3.
  - **Garden-phase runner** (`gardenRunner` in `src/processors/runtime.ts`) — operational as of Phase 4a. Fires garden-phase processors against post-adoption signals + paths.
  - **Garden-emitted PatchEffect → sub-Proposal spawn** (`src/engine/garden/garden.ts`) — operational as of Phase 4a'. Auto-mode PatchEffects from garden-phase processors go through broker enforcement, then spawn sub-Proposals routed through `adopt()` recursively. Cascade depth capped at `DEFAULT_MAX_CASCADE_DEPTH` (10); cap-hit emits `garden.cascade-cap` DiagnosticEffect via the sinks. Propose-mode patches log+drop in v1.0 pending the lint-review surface.
  - **View-phase runner** (`viewRunner` in `src/processors/runtime.ts` + `runViewCommand` in `src/engine/core/commands.ts`) — operational as of Phase 4b. Command-triggered view-phase processors fire on `runViewCommand(name, args)` invocation; the runner finds the at-most-one matching processor (collisions rejected by registry validation as `duplicate-command-trigger`), builds a read-only snapshot at the adopted commit, and routes emitted ViewEffects through `applyEffect({ phase: "view" })`. Non-View effect emissions surface as `phase-mismatch` diagnostics in the result's `brokerDiagnostics` field.
  - **Scheduler** (`runScheduler` in `src/engine/operational/scheduler.ts` + minimal cron evaluator in `src/engine/operational/cron.ts`) — operational as of Phase 4c. Schedule-triggered garden processors fire when due per their cron expression, against `projection.db.schedule_cursors`. The scheduler runs once per top-level adoption attempt (not per sub-Proposal). Cursor lifecycle: new processor fires on first tick; cron change resets the cursor; missed intervals collapse (at-most-once-per-sync clamp per [[wiki/gotchas/scheduled-hook-idempotency]]). Clock injection via `runOneAdoption({ now })` lets the harness's `TestClock` drive deterministic schedule testing.
  - **Answer-trigger dispatch** (`src/engine/operational/answers.ts`) — operational. Garden-phase answer handlers match answered QuestionEffect rows by optional originating `questionProcessorId` plus optional `idempotencyKeyPrefix`.
  - **Answer dispatcher** (`runAnswerHandlers` in `src/engine/operational/answers.ts`) — operational. `dome resolve` / `dome answer` records the answer row, then dispatches matching garden-phase answer handlers against the adopted snapshot. Handler effects route through normal garden effect routing; PatchEffects become garden sub-Proposals.

- Forward-looking:
  - **Engine signal pub/sub** — a future extension of the signal namespace. The current closed `Signal` union does not include `engine.<name>` signals.
  - A doc-driven lockstep test that derives the allowed matrix directly from this file is still planned; current coverage lives in manifest-schema and bundle-loader tests.

## Edge: periodic reports

Periodic reports are garden work in v1, even when the same report can also be
rendered on demand by a command-triggered view processor. The garden processor
owns the schedule and emits durable effects: a PatchEffect for a report page,
a DiagnosticEffect for an operator finding, or an ExternalActionEffect for
outbox-mediated delivery. The view processor owns interactive rendering and
declares only a command trigger.

## Related

- [[wiki/specs/processors]] §"Triggers and signals"
- [[wiki/specs/processors]] §"The three phases"
- [[wiki/specs/adoption]] — when adoption-phase processors run
- [[wiki/matrices/effect-router-targets]] — what each phase can emit
- [[wiki/matrices/built-in-extensions-x-phase]] — per-bundle map of phase × processors
