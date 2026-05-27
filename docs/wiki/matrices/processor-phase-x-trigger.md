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

**As of Phase 3 (processor runtime landed; per-processor manifest validator forward-looking):**

The phase × trigger matrix is **the canonical contract** that the manifest validator will enforce. The type-system fences at the `Trigger` and `ProcessorPhase` level are real today; the per-processor declaration check at bundle load ships with Phase 6.

- Structurally true now:
  - The closed `Trigger` discriminated union in `src/core/processor.ts:123-127` (with per-variant types at 105-121) enforces the four trigger kinds at the type system level.
  - The closed `ProcessorPhase` literal-union at `src/core/processor.ts:75` enforces the three phases.
  - `src/processors/triggers.ts:matchTriggers` (line 83) consumes only `signal` and `path` triggers (returning no match for `schedule`/`command`) — the adoption-phase runner thus naturally honors the adoption × {signal, path} subset of the matrix.

- Forward-looking (Phase 6+):
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
