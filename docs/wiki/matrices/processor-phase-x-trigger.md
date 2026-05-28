---
type: matrix
created: 2026-05-27
updated: 2026-05-27
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
---

# Processor phase × trigger matrix

Maps the three processor phases (adoption / garden / view) to the trigger kinds (signal / path / schedule / command) they may register against. Phase × trigger compatibility is enforced at bundle load by the manifest validator; an incompatible declaration fails the load with `processor-invalid`.

## The matrix

| Trigger kind ↓ \ Phase → | adoption | garden | view |
|---|---|---|---|
| **`signal`** (`file.created`, `file.modified`, `file.deleted`, `document.changed`, `frontmatter.changed`, `region.changed`, `link.added`, `link.removed`) | ✓ Allowed | ✓ Allowed | ✗ Rejected |
| **`path`** (path glob pattern) | ✓ Allowed | ✓ Allowed | ✗ Rejected |
| **`schedule`** (cron expression) | ✗ Rejected — adoption is per-Proposal, not periodic | ✓ Allowed | ✓ Allowed (the cron-driven CLI commands like `dome lint --schedule weekly`) |
| **`command`** (command name) | ✗ Rejected — adoption isn't user-invoked | ✗ Rejected — garden runs autonomously | ✓ Allowed (`dome lint`, `dome query`, `dome export-context`, ...) |

## Phase semantics recap

- **Adoption** — runs inside the fixed-point loop. Bounded, deterministic, merge-blocking. Subscribes to per-Proposal signals computed from the candidate-tree diff. Never invoked by cron or user command (it runs because a Proposal is being adopted).
- **Garden** — runs async on adopted state. May be slow; may call LLMs. Triggered by signals (e.g., post-adoption "new entity page appeared"), paths, or cron schedules. Not user-invoked directly — the engine schedules garden runs.
- **View** — runs on demand for queries / CLI commands / MCP `dome.run_command`. Read-only; renders responses from adopted state + projections. May also run on cron when the view is a periodic deliverable (weekly lint report).

## Why each rejection

| Rejection | Reason |
|---|---|
| adoption × schedule | Adoption is per-Proposal — the adoption loop doesn't have a "next cron tick" semantic. A processor that wants periodic execution lives in garden or view phase. |
| adoption × command | Same — adoption runs because a Proposal needs adopting, not because a user typed `dome <name>`. A view-phase processor handles command invocations and may submit a Proposal via the engine if it wants to write. |
| garden × command | Garden runs are scheduled by the engine, not the user. A user-invokable operation is view-phase; if the view-phase processor needs to write, it emits an Effect that re-enters as a garden-phase Proposal. |
| view × signal / path | Views render on demand, not on writes. A processor that reacts to a vault write is adoption-phase or garden-phase. |

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

The `ALLOWED` constant is derived from this matrix at module-load time (or from a hardcoded mirror that's lockstep-checked against this doc in `tests/integration/processor-phase-x-trigger-coverage.test.ts`).

## Implementation status

**As of Phase 4c (garden runner + sub-Proposal spawn + view runner + scheduler shipping; signal pub/sub + `answer` trigger kind in subsequent phases per [[cohesive/brainstorms/2026-05-27-v1-engine-completion]]):**

The phase × trigger matrix is **the canonical contract** that the manifest validator will enforce. The type-system fences at the `Trigger` and `ProcessorPhase` level are real today; the per-processor declaration check at bundle load ships with Phase 6.

- Structurally true now:
  - The closed `Trigger` discriminated union in `src/core/processor.ts` enforces the four trigger kinds at the type system level. Phase 4d adds a fifth — `{ kind: "answer"; codePrefix: string }`.
  - The closed `ProcessorPhase` literal-union enforces the three phases.
  - `src/processors/triggers.ts:matchTriggers` consumes `signal` and `path` triggers; `schedule` and `command` triggers return no match (the clock-cursor and command-dispatch layers ship in Phase 4c and Phase 4b respectively).
  - **Adoption-phase runner** (`adoptionRunner` in `src/processors/runtime.ts`) — operational since Phase 3.
  - **Garden-phase runner** (`gardenRunner` in `src/processors/runtime.ts`) — operational as of Phase 4a. Fires garden-phase processors against post-adoption signals + paths. Schedule triggers still no-op (Phase 4c). Engine signal triggers (`signal: "engine.*"`) ship in Phase 4d.
  - **Garden-emitted PatchEffect → sub-Proposal spawn** (`src/engine/garden.ts`) — operational as of Phase 4a'. Auto-mode PatchEffects from garden-phase processors go through broker enforcement, then spawn sub-Proposals routed through `adopt()` recursively. Cascade depth capped at `DEFAULT_MAX_CASCADE_DEPTH` (10); cap-hit emits `garden.cascade-cap` DiagnosticEffect via the sinks. Propose-mode patches log+drop in v1.0 pending the lint-review surface.
  - **View-phase runner** (`viewRunner` in `src/processors/runtime.ts` + `runViewCommand` in `src/engine/commands.ts`) — operational as of Phase 4b. Command-triggered view-phase processors fire on `runViewCommand(name, args)` invocation; the runner finds the at-most-one matching processor (collisions rejected at bundle load per `cli-command-collision`), builds a read-only snapshot at the adopted commit, and routes emitted ViewEffects through `applyEffect({ phase: "view" })`. Non-View effect emissions surface as `phase-mismatch` diagnostics in the result's `brokerDiagnostics` field.
  - **Scheduler** (`runScheduler` in `src/engine/scheduler.ts` + minimal cron evaluator in `src/engine/cron.ts`) — operational as of Phase 4c. Schedule-triggered garden + view processors fire when due per their cron expression, against `projection.db.schedule_cursors`. The scheduler runs once per top-level adoption attempt (not per sub-Proposal). Cursor lifecycle: new processor fires on first tick; cron change resets the cursor; missed intervals collapse (at-most-once-per-sync clamp per [[wiki/gotchas/scheduled-hook-idempotency]]). Clock injection via `runOneAdoption({ now })` lets the harness's `TestClock` drive deterministic schedule testing.

- Forward-looking (subsequent Phase 4 phases):
  - **Engine signal pub/sub + `answer` trigger kind** (Phase 4d) — extends `Signal` to include `engine.<name>` namespace; adds the fifth trigger kind for symmetric question-answer handler patterns.
  - The `validateProcessorDeclaration` function shown above does not exist yet. `src/extensions/manifest-schema.ts` today validates only bundle-level fields (`name`, `version`, `deps`) for the Phase 0a bundle loader; the per-processor (phase, trigger) cross-field check that rejects incompatible declarations at registration time ships with the first-party `dome.*` bundle migrations (Phase 6).
  - `tests/integration/processor-phase-x-trigger-coverage.test.ts` is the lockstep that ships with the validator.

## Edge: command-triggered view processors that schedule

Some view processors are *both* user-invokable AND cron-driven — `dome.lint`'s `lint-report` is a canonical example (run via `dome lint` AND via `cron '0 7 * * MON'`). The processor declares two triggers:

```yaml
processors:
  - id: lint-report
    phase: view
    triggers:
      - kind: command
        name: lint
      - kind: schedule
        cron: "0 7 * * MON"
```

Both triggers are allowed by the view row of the matrix. The processor's `run(ctx)` body inspects `ctx.input.triggerKind` (`"command"` or `"schedule"`) and decides whether to render synchronously to the caller (command mode) or write the report to `inbox/review/` (schedule mode).

## Related

- [[wiki/specs/processors]] §"Triggers and signals"
- [[wiki/specs/processors]] §"The three phases"
- [[wiki/specs/adoption]] — when adoption-phase processors run
- [[wiki/matrices/effect-router-targets]] — what each phase can emit
- [[wiki/matrices/built-in-extensions-x-phase]] — per-bundle map of phase × processors
