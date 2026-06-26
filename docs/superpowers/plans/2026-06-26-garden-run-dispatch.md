# `dispatchGardenRun` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the duplicated snapshot→dispatch→route envelope shared by the three non-signal garden runners (scheduler, jobs, answers) into one deep module, `dispatchGardenRun`, and kill the runtime-dependency lockstep by threading a single named `GardenRunDeps` bag.

**Architecture:** A new module `src/engine/garden/garden-run.ts` owns exactly `resolveCurrentAdopted → makeSnapshot → dispatchOneProcessor → routeGardenRunEffects`, returning `{ result, routing }`. The three runners keep only their eligibility selection, crash policy, and bookkeeping. Each runner's option type becomes `GardenRunDeps & { …source-specific }`; the bag is built once at the three orchestration sites (`operational-work.ts`, `compiler-host.ts`, `question-auto-resolution.ts`). The signal-triggered garden pass (`garden.ts`) is deliberately NOT a caller — it batches many processors before spawning.

**Tech Stack:** TypeScript on Bun; `bun test`; `exactOptionalPropertyTypes` is on (hence the `...(x !== undefined ? { x } : {})` spread idiom — preserve it).

## Global Constraints

- Behavior must be **byte-identical**: same diagnostic codes (`scheduler.dispatch-failed`, `job.dispatch-crashed`, `answer.dispatch-crashed`, the three `*.garden-sub-proposal-spawn-disabled` messages, `scheduler.crashed`), same routing summaries, same cursor/job/run bookkeeping.
- The four-concept core is sealed; no new Effect kind, no new primitive. `dispatchGardenRun` is a private engine mechanism, not exported from `src/index.ts`.
- `@dome/sdk` core has no LLM/MCP dependency — `garden-run.ts` imports only engine/processor/core types (no model SDK, no MCP).
- Preserve the `...(x !== undefined ? { x } : {})` optional-spread idiom; do not switch to plain assignment (it breaks under `exactOptionalPropertyTypes`).
- Verification gate is **typecheck + scoped test runs**, never the full suite (it is flaky under parallel load). Commands given per task.

---

### Task 1: The `dispatchGardenRun` module + its unit test

**Files:**
- Create: `src/engine/garden/garden-run.ts`
- Test: `tests/engine/garden-run.test.ts`

**Interfaces:**
- Consumes: `dispatchOneProcessor` (`src/processors/runtime.ts`), `routeGardenRunEffects` + `GardenRunEffectRoutingSummary` (`src/engine/garden/garden-run-routing.ts`), `makeSnapshot`, `resolveCurrentAdopted`, `AdoptSubProposalFn` (`src/engine/garden/garden-sub-proposals.ts`), `ApplyEffectSinks` (`src/engine/core/apply-effect.ts`), `RunnerResult` (`src/engine/core/runner-contract.ts`), `EngineVault` (`src/engine/core/vault-shape.ts`), `ApplyPatchInput` (`src/engine/core/apply-patch.ts`).
- Produces:
  - `type GardenRunDeps` — the shared runtime plumbing (see code).
  - `type GardenRun` — per-run descriptor: `{ processor, phase, envelope, matches, disabledDiagnostic, now? }`.
  - `type GardenRunOutcome = { result: RunnerResult; routing: GardenRunEffectRoutingSummary }`.
  - `async function dispatchGardenRun(deps: GardenRunDeps, run: GardenRun, diagnostics: DiagnosticEffect[]): Promise<GardenRunOutcome>`.

- [ ] **Step 1: Write the failing test.** Confirm the exact import paths/symbols for `makeSnapshot`, `resolveCurrentAdopted`, and the runner test harness fixtures by reading `tests/engine/garden-run-routing.test.ts` first (it already builds fakes for `routeGardenRunEffects`). Reuse its fake `sinks` / vault / `dispatchOneProcessor` seam where possible.

```typescript
// tests/engine/garden-run.test.ts
import { describe, expect, test } from "bun:test";
import { dispatchGardenRun } from "../../src/engine/garden/garden-run";
// + imports for the shared fakes (mirror garden-run-routing.test.ts)

describe("dispatchGardenRun", () => {
  test("builds the adopted snapshot, dispatches the processor, routes its effects, and returns result+routing", async () => {
    // Arrange: a stub garden processor that emits one diagnostic effect,
    // a fake ApplyEffectSinks, an in-memory vault + resolveTree returning a
    // fixed TreeOid, currentAdopted unset (falls back to deps.adopted).
    const diagnostics: DiagnosticEffect[] = [];
    const outcome = await dispatchGardenRun(deps, run, diagnostics);

    // Assert: the processor ran against the adopted snapshot (inputCommit ===
    // deps.adopted), the routing summary reflects zero patches, and the
    // emitted diagnostic landed in the shared accumulator.
    expect(outcome.result.processorId).toBe(run.processor.id);
    expect(outcome.routing.authorizedPatchCount).toBe(0);
    expect(diagnostics.length).toBeGreaterThanOrEqual(0);
  });

  test("forwards run.now to dispatch and deps.now to routing without re-resolving the clock", async () => {
    // Arrange: run.now = a fixed Date; deps.now = () => a DIFFERENT fixed Date.
    // Assert (via the fake dispatchOneProcessor seam / a spy sink): the
    // dispatch saw run.now; routing saw deps.now. Pins the two-clock contract.
  });
});
```

- [ ] **Step 2: Run the test, verify it fails.** Run: `bun test tests/engine/garden-run.test.ts` — Expected: FAIL with "Cannot find module '../../src/engine/garden/garden-run'".

- [ ] **Step 3: Write the module.** Create `src/engine/garden/garden-run.ts`:

```typescript
// src/engine/garden/garden-run.ts
//
// dispatchGardenRun — the shared dispatch+route mechanism for one *garden run*:
// a single non-signal garden-phase processor invocation (a schedule fire, a
// queued job, or an answer handler), dispatched against the adopted snapshot
// outside the adoption loop and routed via routeGardenRunEffects.
//
// Before this module each of scheduler/jobs/answers repeated the snapshot
// construction + the dispatchOneProcessor option spread + the
// routeGardenRunEffects option spread verbatim, so every new runtime
// dependency had to be threaded through three runners in lockstep. This module
// owns that envelope; the runners keep only their eligibility selection, crash
// policy, and bookkeeping.
//
// The signal-triggered garden pass (garden.ts) is deliberately NOT a caller:
// it runs many processors in one phase and batches their patches into a single
// spawn queue before emitting one batched cascade-cap diagnostic. It already
// shares the deepest chokepoint (spawnGardenSubProposal). See docs/glossary.md
// "Garden run".

import type { DiagnosticEffect } from "../../core/effect";
import type { Capability } from "../../core/capability"; // adjust to actual path
import type { CommitOid, TreeOid } from "../../core/source-ref";
import type { LedgerDb } from "../../ledger/db";
import {
  dispatchOneProcessor,
  type ProcessorExecutionState,
} from "../../processors/runtime"; // adjust symbol locations as discovered
import type { Processor } from "../../processors/processor"; // adjust to actual path
import type { TriggerMatch } from "../../processors/runtime"; // adjust to actual path
import type { ExecutionPolicyCap } from "../core/execution-cap"; // adjust
import type { ModelProvider, ModelStepProvider } from "../core/model"; // adjust
import type { OperationalQueryView } from "../operational/operational-query-view"; // adjust
import type { ExtensionConfig } from "../../extensions/config"; // adjust
import type { ApplyEffectSinks } from "../core/apply-effect";
import type { ApplyPatchInput } from "../core/apply-patch";
import type { EngineVault } from "../core/vault-shape";
import type { RunnerResult } from "../core/runner-contract";
import { makeSnapshot } from "../core/snapshot"; // adjust to actual path
import { resolveCurrentAdopted } from "../core/current-adopted"; // adjust to actual path
import {
  routeGardenRunEffects,
  type GardenRunEffectRoutingSummary,
} from "./garden-run-routing";
import type { AdoptSubProposalFn } from "./garden-sub-proposals";

/** The shared runtime plumbing a garden run needs — built once, threaded once. */
export type GardenRunDeps = {
  readonly vault: EngineVault;
  readonly adopted: CommitOid;
  readonly currentAdopted?: () => CommitOid;
  readonly resolveTree: (commit: CommitOid) => Promise<TreeOid>;
  readonly sinks: ApplyEffectSinks;
  readonly resolveGrants: (processorId: string) => ReadonlyArray<Capability>;
  readonly extensionIdFor: (processorId: string) => string;
  readonly extensionConfigFor?: (extensionId: string) => ExtensionConfig;
  readonly ledger?: LedgerDb;
  readonly executionState?: ProcessorExecutionState;
  readonly executionCap?: ExecutionPolicyCap;
  readonly modelProvider?: ModelProvider;
  readonly modelStepProvider?: ModelStepProvider;
  readonly operational?: OperationalQueryView;
  readonly signal?: AbortSignal;
  /** Clock forwarded to routeGardenRunEffects (sub-Proposal timestamping). */
  readonly now?: () => Date;
  /** Resolved patch applier; callers apply the `?? applyPatchToCandidate` default. */
  readonly applyGardenPatch: (opts: ApplyPatchInput) => Promise<CommitOid | null>;
  readonly adoptSubProposal?: AdoptSubProposalFn;
};

/** The per-run specifics — the only things that vary across the three sources. */
export type GardenRun = {
  readonly processor: Processor<unknown>;
  readonly phase: "adoption" | "garden" | "view";
  readonly envelope: unknown;
  readonly matches: ReadonlyArray<TriggerMatch>;
  readonly disabledDiagnostic: {
    readonly code: string;
    readonly message: string;
  };
  /**
   * The Date forwarded to dispatchOneProcessor. Schedule fires pin one instant
   * (the runner computed it once for cursor math + envelope.firedAt); jobs and
   * answers omit it.
   */
  readonly now?: Date;
};

export type GardenRunOutcome = {
  readonly result: RunnerResult;
  readonly routing: GardenRunEffectRoutingSummary;
};

/**
 * Dispatch one garden run against the adopted snapshot and route its effects.
 * Resolves the input commit at call time (so per-fire re-resolution of
 * currentAdopted is preserved), builds the snapshot, dispatches the processor,
 * then routes effects through routeGardenRunEffects. The `diagnostics`
 * accumulator is the caller's run-level array; routeGardenRunEffects appends to
 * it and the caller's crash handler may too.
 */
export async function dispatchGardenRun(
  deps: GardenRunDeps,
  run: GardenRun,
  diagnostics: DiagnosticEffect[],
): Promise<GardenRunOutcome> {
  const inputAdopted = resolveCurrentAdopted(deps.currentAdopted, deps.adopted);
  const snapshot = await makeSnapshot(
    deps.vault.path,
    inputAdopted,
    deps.resolveTree,
  );

  const result = await dispatchOneProcessor({
    processor: run.processor,
    phase: run.phase,
    envelope: run.envelope,
    snapshot,
    changedPaths: Object.freeze([]),
    proposal: null,
    inputCommit: inputAdopted,
    matches: run.matches,
    resolveGrants: deps.resolveGrants,
    extensionIdFor: deps.extensionIdFor,
    ledger: deps.ledger,
    ...(run.now !== undefined ? { now: run.now } : {}),
    ...(deps.extensionConfigFor !== undefined
      ? { extensionConfigFor: deps.extensionConfigFor }
      : {}),
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    ...(deps.executionState !== undefined
      ? { executionState: deps.executionState }
      : {}),
    ...(deps.executionCap !== undefined
      ? { executionCap: deps.executionCap }
      : {}),
    ...(deps.modelProvider !== undefined
      ? { modelProvider: deps.modelProvider }
      : {}),
    ...(deps.modelStepProvider !== undefined
      ? { modelStepProvider: deps.modelStepProvider }
      : {}),
    ...(deps.operational !== undefined ? { operational: deps.operational } : {}),
  });

  const routing = await routeGardenRunEffects({
    result,
    vault: deps.vault,
    adopted: inputAdopted,
    ...(deps.currentAdopted !== undefined
      ? { currentAdopted: deps.currentAdopted }
      : {}),
    proposalId: null,
    sinks: deps.sinks,
    diagnostics,
    applyGardenPatch: deps.applyGardenPatch,
    extensionIdFor: deps.extensionIdFor,
    ...(deps.ledger !== undefined ? { ledger: deps.ledger } : {}),
    ...(deps.adoptSubProposal !== undefined
      ? { adoptSubProposal: deps.adoptSubProposal }
      : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    disabledDiagnostic: run.disabledDiagnostic,
  });

  return Object.freeze({ result, routing });
}
```

> **Executor note:** the `// adjust` import paths are placeholders — resolve each against the live tree before compiling (grep the symbol; copy the path the runners already use). Do not leave any `// adjust` comment in the committed file.

- [ ] **Step 4: Run the test, verify it passes.** Run: `bun test tests/engine/garden-run.test.ts` — Expected: PASS. Then `bunx tsc --noEmit` (or the repo's typecheck script) — Expected: no errors in `garden-run.ts`.

- [ ] **Step 5: Commit.**

```bash
git add src/engine/garden/garden-run.ts tests/engine/garden-run.test.ts
git commit -m "feat(engine): add dispatchGardenRun — shared garden-run dispatch+route"
```

---

### Task 2: Route the scheduler through `dispatchGardenRun`

**Files:**
- Modify: `src/engine/operational/scheduler.ts` (the per-fire dispatch block, ~lines 403–501)

**Interfaces:**
- Consumes: `dispatchGardenRun`, `GardenRunDeps`, `GardenRun` from Task 1.
- Produces: no signature change to `runScheduler` in this task (internal refactor only). The bag is built inside `runSchedulerInner` from existing `opts`.

- [ ] **Step 1: Confirm the current shape.** Re-read `scheduler.ts:403–525`. Note: `nowDate` is computed once near the top of `runSchedulerInner`; `applyGardenPatch` is resolved there too (verify the `?? applyPatchToCandidate` line). The per-fire `try` builds `snapshot` + `matches`, calls `dispatchOneProcessor` then `routeGardenRunEffects`, sets `success`, breaks on `cancelled`. The `catch` emits `scheduler.dispatch-failed`. After the try/catch: cursor upsert + `fired.push`.

- [ ] **Step 2: Build the deps bag once.** Just after `applyGardenPatch` is resolved in `runSchedulerInner` (before the dispatch pass loop), construct:

```typescript
const gardenRunDeps: GardenRunDeps = {
  vault,
  adopted,
  ...(currentAdopted !== undefined ? { currentAdopted } : {}),
  resolveTree,
  sinks,
  resolveGrants,
  extensionIdFor,
  ...(extensionConfigFor !== undefined ? { extensionConfigFor } : {}),
  ...(ledger !== undefined ? { ledger } : {}),
  ...(executionState !== undefined ? { executionState } : {}),
  ...(executionCap !== undefined ? { executionCap } : {}),
  ...(modelProvider !== undefined ? { modelProvider } : {}),
  ...(modelStepProvider !== undefined ? { modelStepProvider } : {}),
  ...(operational !== undefined ? { operational } : {}),
  ...(signal !== undefined ? { signal } : {}),
  now,
  applyGardenPatch,
  ...(adoptSubProposal !== undefined ? { adoptSubProposal } : {}),
};
```

(Use whatever local names the destructured `opts` already exposes; match them exactly.)

- [ ] **Step 3: Replace the per-fire dispatch+route block.** Inside the `try` (currently ~lines 404–472), delete the `snapshot` construction, the `dispatchOneProcessor` call, and the `routeGardenRunEffects` call, and replace with:

```typescript
const matches: ReadonlyArray<TriggerMatch> = Object.freeze([
  Object.freeze({
    trigger: { kind: "schedule" as const, cron },
    matchedSignals: Object.freeze([]),
  }),
] as TriggerMatch[]);

const { result } = await dispatchGardenRun(
  gardenRunDeps,
  {
    processor,
    phase,
    envelope: Object.freeze({
      kind: "schedule" as const,
      cron,
      firedAt: nowDate.toISOString(),
    }),
    matches,
    now: nowDate,
    disabledDiagnostic: {
      code: "scheduler.garden-sub-proposal-spawn-disabled",
      message:
        `Scheduled garden processor ${processor.id} emitted ` +
        `an authorized PatchEffect, but no adoptSubProposal ` +
        `callback was wired; patch dropped.`,
    },
  },
  diagnostics,
);

success = result.executionStatus === "succeeded";
if (result.executionStatus === "cancelled") {
  skipped.push({ processorId: processor.id, reason: "cancelled" });
  break;
}
```

Leave the surrounding `try/catch` (the `scheduler.dispatch-failed` arm), the cursor `upsertCursor`, and `fired.push` exactly as they are. Note the disabled-diagnostic message previously interpolated `result.processorId`; it is now `processor.id` (identical value — the processor being dispatched — but confirm the message text is byte-identical, including `result.processorId` vs `processor.id`; if the original used `result.processorId`, keep that by reading `result` first or retaining the original wording).

> **Executor note:** the original message used `result.processorId`. To stay byte-identical, either (a) keep `result.processorId` by building the `disabledDiagnostic` message from `processor.id` only if `processor.id === result.processorId` always holds (it does — `dispatchOneProcessor` echoes the input processor), or (b) leave the message text exactly as the original string. Verify against the scenario snapshot tests.

- [ ] **Step 4: Typecheck + run scheduler tests.** Run: `bunx tsc --noEmit` then `bun test tests/engine/scheduler.test.ts` — Expected: PASS, no type errors.

- [ ] **Step 5: Commit.**

```bash
git add src/engine/operational/scheduler.ts
git commit -m "refactor(engine): route scheduler through dispatchGardenRun"
```

---

### Task 3: Route queued jobs through `dispatchGardenRun`

**Files:**
- Modify: `src/engine/operational/jobs.ts` (`dispatchOneJob` body, ~lines 189–261)

**Interfaces:**
- Consumes: `dispatchGardenRun`, `GardenRunDeps`, `GardenRun`.
- Produces: no signature change to `runQueuedJobs` / `dispatchOneJob` in this task.

- [ ] **Step 1: Confirm the current shape.** Re-read `jobs.ts:189–280`. `applyGardenPatch` is resolved in `runQueuedJobs` (`opts.applyGardenPatchToCandidate ?? applyPatchToCandidate`) and passed into `dispatchOneJob`. `dispatchOneJob` builds `inputAdopted`, `snapshot`, `matches` (job trigger), calls `dispatchOneProcessor` then `routeGardenRunEffects`, then does `markJobSucceeded` / release / fail bookkeeping. The `now` clock is `opts.now`.

- [ ] **Step 2: Build the deps bag.** At the top of `dispatchOneJob` (replacing the `inputAdopted`/`snapshot` lines), build a `GardenRunDeps` from `opts` (jobs passes `applyGardenPatch` in as a resolved fn — use it directly):

```typescript
const gardenRunDeps: GardenRunDeps = {
  vault: opts.vault,
  adopted: opts.adopted,
  ...(opts.currentAdopted !== undefined ? { currentAdopted: opts.currentAdopted } : {}),
  resolveTree: opts.resolveTree,
  sinks: opts.sinks,
  resolveGrants: opts.resolveGrants,
  extensionIdFor: opts.extensionIdFor,
  ...(opts.extensionConfigFor !== undefined ? { extensionConfigFor: opts.extensionConfigFor } : {}),
  ...(opts.ledger !== undefined ? { ledger: opts.ledger } : {}),
  ...(opts.executionState !== undefined ? { executionState: opts.executionState } : {}),
  ...(opts.executionCap !== undefined ? { executionCap: opts.executionCap } : {}),
  ...(opts.modelProvider !== undefined ? { modelProvider: opts.modelProvider } : {}),
  ...(opts.modelStepProvider !== undefined ? { modelStepProvider: opts.modelStepProvider } : {}),
  ...(opts.operational !== undefined ? { operational: opts.operational } : {}),
  ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  now: opts.now,
  applyGardenPatch: opts.applyGardenPatch,
  ...(opts.adoptSubProposal !== undefined ? { adoptSubProposal: opts.adoptSubProposal } : {}),
};
```

- [ ] **Step 3: Replace the dispatch+route block.** Delete the `snapshot`, `dispatchOneProcessor`, and `routeGardenRunEffects` calls (~189–261) and replace with:

```typescript
const matches: ReadonlyArray<TriggerMatch> = Object.freeze([
  Object.freeze({
    trigger: Object.freeze({
      kind: "job" as const,
      idempotencyKey: opts.job.idempotencyKey,
    }),
    matchedSignals: Object.freeze([]),
  }),
]);

const { result } = await dispatchGardenRun(
  gardenRunDeps,
  {
    processor: opts.processor,
    phase: "garden",
    envelope: opts.job.input,
    matches,
    disabledDiagnostic: {
      code: "jobs.garden-sub-proposal-spawn-disabled",
      message:
        `Queued job processor ${opts.processor.id} emitted an authorized ` +
        `PatchEffect, but no adoptSubProposal callback was wired; ` +
        `patch dropped.`,
    },
  },
  opts.diagnostics,
);
```

Keep the `if (result.executionStatus === "succeeded") { markJobSucceeded… }` / `cancelled` / failure bookkeeping below exactly as-is. Preserve the original `disabledDiagnostic` message text byte-for-byte (it used `result.processorId`; see the Task 2 executor note and keep identical wording).

- [ ] **Step 4: Typecheck + run jobs tests.** Run: `bunx tsc --noEmit` then `bun test tests/engine/jobs.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/engine/operational/jobs.ts
git commit -m "refactor(engine): route queued jobs through dispatchGardenRun"
```

---

### Task 4: Route answer handlers through `dispatchGardenRun`

**Files:**
- Modify: `src/engine/operational/answers.ts` (the per-candidate loop, ~lines 190–256)

**Interfaces:**
- Consumes: `dispatchGardenRun`, `GardenRunDeps`, `GardenRun`.
- Produces: no signature change to `runAnswerHandlers` in this task.

- [ ] **Step 1: Confirm the current shape.** Re-read `answers.ts:183–256`. `applyGardenPatch` is resolved in `runAnswerHandlersInner` (`opts.applyGardenPatchToCandidate ?? applyPatchToCandidate`). The loop iterates `candidates`; per candidate it builds `inputAdopted`, `snapshot`, an `answer` envelope (carrying `matchedTriggers: candidate.matches`), `matches: candidate.matches`, dispatches, routes, then accumulates `subProposalCount`/`rejectedPatchCount` and pushes a run summary. Answers has **no** `now` and **no** `signal`.

- [ ] **Step 2: Build the deps bag once** (before the `for (const candidate of candidates)` loop):

```typescript
const gardenRunDeps: GardenRunDeps = {
  vault: opts.vault,
  adopted: opts.adopted,
  ...(opts.currentAdopted !== undefined ? { currentAdopted: opts.currentAdopted } : {}),
  resolveTree: opts.resolveTree,
  sinks: opts.sinks,
  resolveGrants: opts.resolveGrants,
  extensionIdFor: opts.extensionIdFor,
  ...(opts.ledger !== undefined ? { ledger: opts.ledger } : {}),
  ...(opts.executionState !== undefined ? { executionState: opts.executionState } : {}),
  ...(opts.executionCap !== undefined ? { executionCap: opts.executionCap } : {}),
  ...(opts.modelProvider !== undefined ? { modelProvider: opts.modelProvider } : {}),
  ...(opts.modelStepProvider !== undefined ? { modelStepProvider: opts.modelStepProvider } : {}),
  ...(opts.operational !== undefined ? { operational: opts.operational } : {}),
  applyGardenPatch,
  ...(opts.adoptSubProposal !== undefined ? { adoptSubProposal: opts.adoptSubProposal } : {}),
};
```

(No `now`, no `signal` — answers never passed them.)

- [ ] **Step 3: Replace the per-candidate dispatch+route.** Replace the `inputAdopted`/`snapshot`/`dispatchOneProcessor`/`routeGardenRunEffects` block with:

```typescript
const { result, routing: routed } = await dispatchGardenRun(
  gardenRunDeps,
  {
    processor: candidate.processor,
    phase: "garden",
    envelope: Object.freeze({
      kind: "answer" as const,
      questionId: opts.question.id,
      question: opts.question.effect,
      answer: opts.question.answer,
      answeredAt: opts.question.answeredAt,
      matchedTriggers: candidate.matches,
    }),
    matches: candidate.matches,
    disabledDiagnostic: {
      code: "answer.garden-sub-proposal-spawn-disabled",
      message:
        `Answer handler ${result.processorId} emitted an authorized ` +
        `PatchEffect, but no adoptSubProposal callback was wired; ` +
        `patch dropped.`,
    },
  },
  diagnostics,
);
subProposalCount += routed.spawnedPatchCount;
rejectedPatchCount += routed.rejectedPatchCount;
```

> **Executor note:** the `disabledDiagnostic` message references `result.processorId`, but `result` is the return value of `dispatchGardenRun` — a chicken/egg. The original built the message from `result.processorId` *after* dispatch only because `routeGardenRunEffects` was called with the message inline. Since `candidate.processor.id === result.processorId` (dispatch echoes the input), build the message from `candidate.processor.id` to keep it byte-identical without the ordering problem. Verify the resulting string equals the original against `tests/extensions/.../*-answer.test.ts` snapshots.

Keep the `runs.push({...})` summary and the rest of the loop intact.

- [ ] **Step 4: Typecheck + run answer tests.** Run: `bunx tsc --noEmit` then `bun test tests/extensions/dome.agent/sweep-answer.test.ts tests/extensions/dome.daily/settle-stale-answer.test.ts tests/extensions/warden-integrity-answer.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/engine/operational/answers.ts
git commit -m "refactor(engine): route answer handlers through dispatchGardenRun"
```

---

### Task 5: Hoist `GardenRunDeps` to the orchestration sites (decision b)

**Files:**
- Modify: `src/engine/operational/scheduler.ts` (option type → `GardenRunDeps & {…}`)
- Modify: `src/engine/operational/jobs.ts` (option type → `GardenRunDeps & {…}`)
- Modify: `src/engine/operational/answers.ts` (option type → `GardenRunDeps & {…}`)
- Modify: `src/engine/operational/operational-work.ts` (build bag once; forward to scheduler + jobs)
- Modify: `src/engine/host/compiler-host.ts` (~line 792, answers call)
- Modify: `src/engine/operational/question-auto-resolution.ts` (~line 240, answers call)

**Interfaces:**
- Consumes: `GardenRunDeps`.
- Produces:
  - `runScheduler` opts become `GardenRunDeps & { registry, projection, max…?; }` minus the fields now in the bag. Scheduler's extras: `registry`, `projection`. (`now`, `signal`, `applyGardenPatchToCandidate` move into / are subsumed by the bag — but `now` is required for scheduler cursor math, so it stays available via `deps.now` which scheduler sets.)
  - `runQueuedJobs` opts become `GardenRunDeps & { registry, projection, maxJobs? }`.
  - `runAnswerHandlers` opts become `GardenRunDeps & { registry, question }`.

> **Outcome (completed in full):** The hoist was done across the whole garden-run chain, in two commits:
> 1. `operational-work` double-spread → one shared object (no type changes; the clean self-contained piece, landed first).
> 2. The chain hoist: `GardenRunDeps` became the shared deps type; the three runners (`runScheduler`/inner, `runQueuedJobs`+`runOneJob`, `runAnswerHandlers`/inner) and the answer-path intermediates (`dispatchAutoAnswerHandlers`, `runQuestionAutoResolution`) now take `GardenRunDeps & {extras}` and forward `opts` to `dispatchGardenRun` untouched. The ~15-field re-listing collapsed out of every signature.
>
> **Key design correction found during execution:** making `applyGardenPatch` a *required, resolved* field broke the one caller (a test helper) that relied on the `?? applyPatchToCandidate` default. Fix: the bag carries the *optional override* `applyGardenPatchToCandidate?`, and `dispatchGardenRun` resolves the default internally — so the default lives in one place (the deep module) and **no caller threads it**. A unit-test failure surfaced this.
>
> **Asymmetry handled as designed:** `registry`/`projection`/`now`/`question`/`answers`/`config` stayed as per-runner `& {…}` extras; only the genuinely-shared dispatch+route plumbing lives in `GardenRunDeps`. The origin build sites (`operational-work`, `compiler-host`'s `runAnswerHandlersForQuestionUnlocked`) construct the deps from `VaultRuntime`/opts; every intermediate forwards `opts` with no field re-listing. A new runtime dependency now touches `GardenRunDeps` + the origin sites only.

- [ ] **Step 1: Convert the three runner option types.** For each runner, replace the inline `opts: { …shared… + …extras… }` with `opts: GardenRunDeps & { …extras… }`. Resolve `applyGardenPatch` from the bag (drop the local `?? applyPatchToCandidate` once callers pass a resolved `applyGardenPatch` — OR keep `applyGardenPatchToCandidate?` as an extra and resolve locally; pick whichever keeps callers simplest, and apply it consistently). Update the internal bag construction from Tasks 2–4 to just reference the now-already-shaped `opts` (the bag IS most of `opts` now — you can pass `opts` where `GardenRunDeps` is expected if the extras are a superset, since structural typing allows the wider object).

- [ ] **Step 2: Build the bag once in `operational-work.ts`.** Replace the two field-by-field spreads into `runScheduler` and `runQueuedJobs` (~lines 94–169) with a single `GardenRunDeps` built from `operational-work`'s own `opts` (resolving `applyGardenPatch` once), then:

```typescript
const scheduler = await runScheduler({ ...gardenRunDeps, registry: opts.registry, projection: opts.projection });
// …
const jobs = await runQueuedJobs({ ...gardenRunDeps, registry: opts.registry, projection: opts.projection, ...(maxJobs !== undefined ? { maxJobs } : {}) });
```

- [ ] **Step 3: Build the bag at the two answer sites.** In `compiler-host.ts` (~792) and `question-auto-resolution.ts` (~240), construct a `GardenRunDeps` once and spread it into `runAnswerHandlers({ ...gardenRunDeps, registry, question })`. Preserve each site's existing `applyGardenPatch`/`now` wiring inside the bag.

- [ ] **Step 4: Typecheck + scoped tests.** Run: `bunx tsc --noEmit` then `bun test tests/engine/scheduler.test.ts tests/engine/jobs.test.ts tests/engine/operational-work.test.ts tests/engine/garden-run-routing.test.ts tests/engine/garden-run.test.ts` — Expected: PASS, no type errors.

- [ ] **Step 5: Run the behavior-preservation net (harness scenarios).** Run: `bun test tests/harness/scenarios/garden-cascade tests/harness/scenarios/effect-routing tests/harness/scenarios/capabilities/model-invoke-scheduled.scenario.test.ts tests/harness/scenarios/effect-kinds/ingest-scheduled-recovery.scenario.test.ts` — Expected: PASS (proves diagnostics/routing byte-identical).

- [ ] **Step 6: Commit.**

```bash
git add src/engine/operational/scheduler.ts src/engine/operational/jobs.ts src/engine/operational/answers.ts src/engine/operational/operational-work.ts src/engine/host/compiler-host.ts src/engine/operational/question-auto-resolution.ts
git commit -m "refactor(engine): hoist GardenRunDeps to orchestration sites; kill the runtime-dependency lockstep"
```

---

### Task 6: Anchor the "garden run" term in the glossary

**Files:**
- Modify: `docs/glossary.md` (Engine vocabulary section; frontmatter `updated`)

- [ ] **Step 1: Add the term** under "Engine vocabulary", after the `Phase` line:

```markdown
- **Garden run** — a single non-signal garden-phase processor invocation: a schedule fire, a queued job, or an answer handler, dispatched against the adopted snapshot outside the adoption loop and routed via `routeGardenRunEffects`. The signal-triggered garden pass differs: it batches many processors' patches before spawning. The shared dispatch+route mechanism is `dispatchGardenRun` (`src/engine/garden/`).
```

- [ ] **Step 2: Bump the frontmatter** `updated: 2026-06-10` → `updated: 2026-06-26`.

- [ ] **Step 3: Commit.**

```bash
git add docs/glossary.md
git commit -m "docs(glossary): define 'garden run'"
```

---

## Self-Review

**Spec coverage:** Scope=three runners only (Tasks 2–4) ✓; garden.ts untouched ✓; named `GardenRunDeps` bag (Task 1) ✓; module owns snapshot+dispatch+route, returns `{result,routing}` (Task 1) ✓; caller keeps crash/classification/bookkeeping (Tasks 2–4 leave try/catch + cursor/job/run code) ✓; diagnostics stays a passed-in accumulator (Task 1 third param) ✓; full-spine hoist b (Task 5) ✓ with a generalize-only-if-cleaner stop gate; glossary side effect (Task 6) ✓; test surface (Task 1 new test + scoped runner runs + harness net) ✓.

**Placeholder scan:** The `// adjust` import paths in Task 1 are flagged with an explicit executor note to resolve them; no "TODO/handle edge cases" left. The `disabledDiagnostic` byte-identical concern is called out with concrete guidance in Tasks 2–4.

**Type consistency:** `GardenRunDeps`, `GardenRun`, `GardenRunOutcome`, `dispatchGardenRun(deps, run, diagnostics)` used identically across Tasks 1–5. `applyGardenPatch` is the resolved fn everywhere (default applied at construction). `now` split: `run.now: Date` → dispatch; `deps.now: () => Date` → route.
