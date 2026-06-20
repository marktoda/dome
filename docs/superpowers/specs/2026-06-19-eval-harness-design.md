---
type: spec
tags:
  - design
  - eval
  - testing
  - agent
created: 2026-06-19
status: approved-design
sources:
  - "[[wiki/gotchas/agent-prompt-regression]]"
  - "[[wiki/specs/autonomous-agents]]"
  - "[[wiki/specs/processor-execution]]"
description: "A reusable EvalHarness that asserts LLM/agent behavior (not just deterministic code). Thin vertical slice proven on dome.agent.brief, designed so new agents, assertion kinds, live mode, and CI-gating are additions, not redesigns."
---

# EvalHarness — design

## Why

Dome has ~2,900 deterministic tests + structural linters, but **zero semantic assertions on any model output**. The LLM-driven garden processors and autonomous agents (`dome.agent.ingest`/`consolidate`/`brief`/`sweep`) are tested only by direct `run(ctx)` with a scripted `stepFn` (unit-level) or a manual live smoke script (`scripts/v1-llm-smoke.ts`, not in CI). A model upgrade or prompt edit that degrades behavior ships green. The project's own philosophy says LLM behavior wants **eval harnesses, not cell-tests** — and the deferred gotcha [[wiki/gotchas/agent-prompt-regression]] already reserves the path `src/eval/replay.ts` for exactly this. This builds it.

This is the architecture review's highest-leverage "Next" item (review §3.2), scoped to a **thin vertical slice** proven on one agent, built as a clean lego-block the rest slots into.

## Scope

**In (the slice):**
- The harness machinery: `EvalCase` / `Assertion` / `runEvalSuite` + an `EvalReport`.
- A hermetic **scripted model provider** for eval runs; a `--live` swap to real Anthropic.
- A golden-vault fixture convention + loader.
- **One** real case: `dome.agent.brief` run **through the real engine** (temp vault → engine tick with scripted provider → capture output), asserting brief shape + read-before-write trajectory.
- A `bun run eval` entry; hermetic-by-default, behind the test-env guard.
- A unit test of the harness itself.

**Out (deferred — must be clean *additions* per the extensibility seams below, not redesigns):**
- The other three agents (ingest/consolidate/sweep) + the hosted `/agent` path — future `EvalCase`s.
- LLM-as-judge, output-entropy, citation-validity assertions — future `Assertion` factories.
- Wiring `--live` eval into a weekly CI lane — future config.

## Architecture

### The lego-block (3 types, `src/eval/types.ts`)

```ts
/** One behavioral test: produce an output by running an agent, then assert over it. */
export type EvalCase<O> = {
  readonly name: string;
  readonly run: (env: EvalEnv) => Promise<O>;
  readonly assertions: ReadonlyArray<Assertion<O>>;
};

/** Pass = null; fail = a human-readable reason. Async so LLM-as-judge slots in later unchanged. */
export type Assertion<O> = (output: O) => string | null | Promise<string | null>;

/** Per-case, per-assertion result + the suite roll-up. */
export type EvalResult = {
  readonly case: string;
  readonly failures: ReadonlyArray<string>; // empty = passed
};
export type EvalReport = {
  readonly results: ReadonlyArray<EvalResult>;
  readonly passed: number;
  readonly failed: number;
};

/** What a case's run() needs from the harness — chiefly the injected model provider (hermetic | live). */
export type EvalEnv = {
  readonly modelProvider: CommandModelProvider; // Dome's existing model-provider seam
  readonly mode: "hermetic" | "live";
};
```

`Assertion<O>` is the key extensibility seam: vault-diff, trajectory, and every future semantic check (LLM-as-judge, entropy, citation-validity) are all just `Assertion`s. A judge assertion is an `async` one calling a pinned judge model — no core change.

### The runner (`src/eval/run-suite.ts`)

```ts
export async function runEvalSuite(
  cases: ReadonlyArray<EvalCase<unknown>>,
  opts: { readonly env: EvalEnv; readonly log?: (line: string) => void },
): Promise<EvalReport>;
```

Runs each case's `run(env)`, applies every assertion to the output (awaiting async ones), collects failures, prints a per-case report. The CLI entry maps a non-empty `failed` to a non-zero exit.

### The provider seam (hermetic / live)

`EvalEnv` carries the model provider the agent run uses. Two implementations behind Dome's existing model-provider seam (the same seam garden `model.invoke` processors use):
- **Hermetic (default):** a **scripted provider** that returns a fixed tool-call/text script per case (the shape `dome.agent.*` unit tests already drive via `stepFn`). Deterministic, offline, CI-safe.
- **Live (`--live`):** the real Anthropic provider (the `createRealLLMHarness` path), pinned model id, never run in CI by default.

Because the provider is injected, **"live mode" is a provider swap with zero core change.** The hermetic default + the existing `tests/preload.ts` guard (clears `ANTHROPIC_API_KEY`, points base URL at a dead loopback) keep CI offline.

### Golden-vault fixtures

A fixture is a seed vault snapshot + the agent task + the scripted provider script + the expected outcome. Layout:
- Vault snapshot + expected output: `tests/fixtures/eval/<case>/` (alongside other fixtures).
- The `EvalCase` itself: `src/eval/cases/<case>.ts` (imports the harness, points at its fixture dir, declares its assertions).

Adding an agent = a new fixture dir + a new case file. No harness change.

### The slice: `dome.agent.brief` (`src/eval/cases/brief.ts`)

`run(env)`:
1. Materialize a temp vault from `tests/fixtures/eval/brief-basic/` (a small seeded vault with the inputs the brief agent reads).
2. `openVault` + run the `dome.agent.brief` processor **through the real engine tick** with `env`'s scripted provider (this catches wiring regressions, not just `run(ctx)` logic — closes review finding E2 for one agent).
3. Capture `O = { brief: string; trajectory: ToolCallTrace[] }` — the produced brief markdown + the ordered tool calls the model made.

Assertions (slice):
- `briefShapeValid` — front-matter present, the required sections present, body under the brief's token budget (the brief agent's deterministic-failure contract from [[wiki/specs/autonomous-agents]]).
- `trajectoryReadsBeforeWrites` — no write/emit tool call precedes the reads it depends on (a trajectory-quality guard).

Both live in `src/eval/assertions.ts` as `Assertion<BriefOutput>` factories.

### `bun run eval`

A `scripts/eval.ts` (or `src/eval/cli.ts`) that loads the registered cases, builds the hermetic `EvalEnv` (or live with `--live`), calls `runEvalSuite`, prints the report, exits non-zero on failure. Added to `package.json` scripts. NOT added to `v1:check` in the slice (hermetic eval *could* join `check` later; live stays a separate lane) — wiring is a deferred decision, not part of this build.

## Components & boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| `src/eval/types.ts` | The 3 types + `EvalEnv` | nothing |
| `src/eval/run-suite.ts` | Run cases, apply assertions, build report | types |
| `src/eval/assertions.ts` | `Assertion` factories (slice: brief-shape, trajectory) | types |
| `src/eval/cases/brief.ts` | The brief `EvalCase` + fixture wiring | types, the brief agent, engine openVault |
| `scripts/eval.ts` | CLI: build env, run suite, exit code | run-suite, cases |
| `tests/fixtures/eval/brief-basic/` | Seed vault + scripted script + expected | — |

The harness (`types`/`run-suite`/`assertions`) knows nothing about any specific agent — agents enter only via `cases/*`. The provider seam keeps hermetic/live out of the core.

## Error handling

- A case whose `run()` throws → recorded as a failure with the error message (the suite continues; one broken case doesn't abort the others).
- An assertion that throws → treated as a failure with the thrown message (assertions should return reasons, not throw, but the runner is defensive).
- Live mode with no `ANTHROPIC_API_KEY` → fail loudly at env construction (don't silently fall back to hermetic — that would hide a misconfigured live run).

## Testing

- **Harness unit test** (`tests/eval/run-suite.test.ts`): a trivial `EvalCase` with one passing + one failing (sync) assertion + one async assertion proves `runEvalSuite` reports failures correctly, awaits async assertions, and that a throwing `run()`/assertion becomes a failure not a crash.
- **The brief case is the first real eval**, run hermetically: `bun run eval` green on a known-good scripted script; flip one scripted step to violate `briefShapeValid` and confirm the eval fails (proves the assertion bites — done as a temporary local check, reverted).
- Hermetic-by-default; the suite must run offline under the existing test-env guard.

## Extensibility seams (the design's whole point)

1. **New agent** → new `src/eval/cases/<agent>.ts` + `tests/fixtures/eval/<case>/`. No change to types/run-suite/assertions core.
2. **New assertion kind** (LLM-as-judge, entropy, citation-validity) → new factory in `assertions.ts` returning `Assertion<O>` (async allowed). No core change.
3. **Live behavioral runs** → `--live` provider swap in the CLI. No core change.
4. **CI gating** → `bun run eval` is the entry; adding a hermetic eval lane to `check` or a weekly live lane is config, not redesign.

## Out of scope / non-goals

- Not a replacement for the deterministic suite or the structural linters — it covers the LLM-behavior layer those can't.
- No distribution-entropy / drift dashboards in the slice (a future `Assertion` + reporting concern).
- No change to the agents themselves — this observes them.
