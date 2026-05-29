---
type: matrix
created: 2026-05-27
updated: 2026-05-28
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
---

# Processor phase × trigger matrix

Maps the three processor phases (adoption / garden / view) to the trigger kinds (signal / path / schedule / answer / command) they may register against. Phase × trigger compatibility is enforced at bundle load by the manifest validator; an incompatible declaration fails the load with `processor-invalid`.

## The matrix

| Trigger kind ↓ \ Phase → | adoption | garden | view |
|---|---|---|---|
| **`signal`** (`file.created`, `file.modified`, `file.deleted`, `document.changed`, `frontmatter.changed`, `region.changed`, `link.added`, `link.removed`) | ✓ Allowed | ✓ Allowed | ✗ Rejected |
| **`path`** (path glob pattern) | ✓ Allowed | ✓ Allowed | ✗ Rejected |
| **`schedule`** (cron expression) | ✗ Rejected — adoption is per-Proposal, not periodic | ✓ Allowed | ✓ Allowed for read-only scheduled reports; write-producing scheduled work belongs in garden |
| **`answer`** (QuestionEffect answer, optionally narrowed by idempotency-key prefix) | ✗ Rejected — answers are user decisions after adoption | ✓ Allowed | ✗ Rejected |
| **`command`** (command name) | ✗ Rejected — adoption isn't user-invoked | ✗ Rejected — garden runs autonomously | ✓ Allowed (`dome query`, `dome lint`, `dome export-context`) |

## Phase semantics recap

- **Adoption** — runs inside the fixed-point loop. Bounded, deterministic, merge-blocking. Subscribes to per-Proposal signals computed from the candidate-tree diff. Never invoked by cron or user command (it runs because a Proposal is being adopted).
- **Garden** — runs async on adopted state. May be slow; may call LLMs. Triggered by signals (e.g., post-adoption "new entity page appeared"), paths, cron schedules, or answered questions. Not user-invoked directly — the engine schedules garden runs.
- **View** — runs on demand for queries / CLI commands / MCP `dome.run_command`. Read-only; renders responses from adopted state + projections. May also run on cron when the view is a periodic read-only deliverable.

## Why each rejection

| Rejection | Reason |
|---|---|
| adoption × schedule | Adoption is per-Proposal — the adoption loop doesn't have a "next cron tick" semantic. A processor that wants periodic execution lives in garden or view phase. |
| adoption × command | Same — adoption runs because a Proposal needs adopting, not because a user typed `dome <name>`. A view-phase processor handles command invocations; if a command needs to cause writes, it should enqueue or ask for garden-phase work rather than emit PatchEffects directly. |
| adoption × answer | Answers arrive after a question row exists in adopted-state operational substrate; handling them belongs in garden. |
| garden × command | Garden runs are scheduled by the engine, not the user. A user-invokable operation is view-phase; writes belong behind garden/adoption routing, not direct command-triggered patches. |
| view × signal / path / answer | Views render on demand, not on writes or user-decision events. A processor that reacts to a vault write or answer is adoption-phase or garden-phase. |

## How the validator catches mismatches

`src/extensions/manifest-schema.ts` validates manifest declarations against this matrix:

```ts
function validateProcessorDeclaration(decl: ProcessorDeclaration): Result<void, ManifestError> {
  for (const trigger of decl.triggers) {
    if (!ALLOWED[decl.phase].has(trigger.kind)) {
      return Result.err({
        kind: "processor-invalid",
        message: `Processor ${decl.id} has phase ${decl.phase} but declares ${trigger.kind} trigger — incompatible per processor-phase-x-trigger matrix.`,
      });
    }
  }
  return Result.ok();
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
  - **Garden-emitted PatchEffect → sub-Proposal spawn** (`src/engine/garden.ts`) — operational as of Phase 4a'. Auto-mode PatchEffects from garden-phase processors go through broker enforcement, then spawn sub-Proposals routed through `adopt()` recursively. Cascade depth capped at `DEFAULT_MAX_CASCADE_DEPTH` (10); cap-hit emits `garden.cascade-cap` DiagnosticEffect via the sinks. Propose-mode patches log+drop in v1.0 pending the lint-review surface.
  - **View-phase runner** (`viewRunner` in `src/processors/runtime.ts` + `runViewCommand` in `src/engine/commands.ts`) — operational as of Phase 4b. Command-triggered view-phase processors fire on `runViewCommand(name, args)` invocation; the runner finds the at-most-one matching processor (collisions rejected by registry validation as `duplicate-command-trigger`), builds a read-only snapshot at the adopted commit, and routes emitted ViewEffects through `applyEffect({ phase: "view" })`. Non-View effect emissions surface as `phase-mismatch` diagnostics in the result's `brokerDiagnostics` field.
  - **Scheduler** (`runScheduler` in `src/engine/scheduler.ts` + minimal cron evaluator in `src/engine/cron.ts`) — operational as of Phase 4c. Schedule-triggered garden + view processors fire when due per their cron expression, against `projection.db.schedule_cursors`. The scheduler runs once per top-level adoption attempt (not per sub-Proposal). Cursor lifecycle: new processor fires on first tick; cron change resets the cursor; missed intervals collapse (at-most-once-per-sync clamp per [[wiki/gotchas/scheduled-hook-idempotency]]). Clock injection via `runOneAdoption({ now })` lets the harness's `TestClock` drive deterministic schedule testing.
  - **Answer-trigger dispatch** (`src/engine/answers.ts`) — operational. Garden-phase answer handlers match answered QuestionEffect rows by optional originating `questionProcessorId` plus optional `idempotencyKeyPrefix`.
  - **Answer dispatcher** (`runAnswerHandlers` in `src/engine/answers.ts`) — operational. `dome answer` records the answer row, then dispatches matching garden-phase answer handlers against the adopted snapshot. Handler effects route through normal garden effect routing; PatchEffects become garden sub-Proposals.

- Forward-looking:
  - **Engine signal pub/sub** — a future extension of the signal namespace. The current closed `Signal` union does not include `engine.<name>` signals.
  - A doc-driven lockstep test that derives the allowed matrix directly from this file is still planned; current coverage lives in manifest-schema and bundle-loader tests.

## Edge: command-triggered view processors that schedule

Some view processors are *both* user-invokable AND cron-driven when the cron path only renders or records a read-only report for a protocol surface. The processor declares two triggers:

```yaml
processors:
  - id: dome.lint.report
    phase: view
    triggers:
      - kind: command
        name: lint
      - kind: schedule
        cron: "0 7 * * MON"
```

Both triggers are allowed by the view row of the matrix. The processor's `run(ctx)` body inspects `ctx.input.triggerKind` (`"command"` or `"schedule"`) and renders an appropriate ViewEffect. If the scheduled path needs to mutate vault markdown, that work belongs in a garden processor because `applyEffect({ phase: "view" })` rejects write effects.

## Related

- [[wiki/specs/processors]] §"Triggers and signals"
- [[wiki/specs/processors]] §"The three phases"
- [[wiki/specs/adoption]] — when adoption-phase processors run
- [[wiki/matrices/effect-router-targets]] — what each phase can emit
- [[wiki/matrices/built-in-extensions-x-phase]] — per-bundle map of phase × processors
