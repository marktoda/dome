# EvalHarness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reusable, extensible EvalHarness that asserts LLM/agent behavior, proven on a thin vertical slice — `dome.agent.brief` run through the real engine with a hermetic scripted model provider, asserting brief shape + tool-call trajectory.

**Architecture:** Three-type lego-block (`EvalCase<O>` / `Assertion<O>` / `runEvalSuite`) with the model provider injected so hermetic↔live is a swap, not a redesign. A small symmetric SDK addition (`modelStepProvider` override on the vault-open path, mirroring the existing text-provider override) lets the eval run a tool-calling agent through the real engine hermetically. Spec: `docs/superpowers/specs/2026-06-19-eval-harness-design.md`.

**Tech Stack:** TypeScript, Bun, `bun test ./tests`, the Dome engine (`openVault`/`sync`), the `dome.agent.brief` agent.

## Global Constraints

- **Canonical gate:** `bun test ./tests` (NOT bare `bun test` — sweeps `pwa/`; NOT `tsc` — pre-existing red). The eval CLI runs via `bun run eval`.
- **Hermetic-by-default:** the eval suite runs offline under the existing test-env guard (`tests/preload.ts` clears `ANTHROPIC_API_KEY`, points base URL at a dead loopback). Live behavioral runs are `--live` only and never in CI by default.
- **Do NOT add `bun run eval` to `v1:check`** in this slice (wiring an eval lane into the gate is a deferred decision).
- **House style (docs/philosophy.md):** pure-decide + thin shells; named invariants with mechanical enforcers; structural > prose; locality > centralization; do NOT generalize at N=1 — but the harness core is generic by design (the spec's extensibility seams), so genericity here is the point, not premature abstraction.
- **Extensibility seams are load-bearing (spec §"Extensibility seams"):** new agent = new case + fixture; new assertion = new factory; live = provider swap; CI = config. No task may bake an agent-specific assumption into the harness core (`types`/`run-suite`).
- **Mutation-fence:** any new non-test file under `src/` calling `writeFile`/`mkdir`/git-write must be added to `tests/integration/no-direct-mutation-outside-boundaries.test.ts` ALLOWED_FILES. The eval modules are read/assert + spawn-a-vault; the temp-vault setup writes files — if eval code writes to disk outside the vault APIs, allow-list it (Task 5 notes this).
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## Recon facts (verified — build on these)

- Scripted step seam: `ModelStepFn = (input: ModelStepInput) => Promise<ModelStepResult>`; `ModelStepInput = { messages, tools, model? }`, `ModelStepResult = { toolCalls?: ModelToolCall[]; text? }` — `src/core/processor.ts:397-416`.
- `openVaultRuntime(opts)` (`src/engine/host/vault-runtime.ts:335`) resolves providers at ~422-427: `const modelProvider = opts.modelProvider ?? builtProviders?.text; const modelStepProvider = builtProviders?.step;` — **the text provider is overridable, the step provider is NOT.** This is the gap Task 1 closes.
- `openVault({ path, bundlesRoot? })` → `Vault` with `sync(opts?)` — `src/vault.ts:296,308`.
- Brief: `assets/extensions/dome.agent/processors/brief.ts` — agent loop via `lib/agent-loop.ts` (`runAgentLoop`, uses `opts.step`); writes `wiki/dailies/YYYY-MM-DD.md` within `dome.agent.brief:*` marker blocks; daily front matter `type: daily`; every model bullet must cite a `[[wikilink]]`; deterministic skeleton has `## Open Loops`. Schedule-triggered (cron `30 5 * * *`) OR signal-triggered on new calendar/slack source files.
- Temp-vault pattern: `scripts/v1-llm-smoke.ts:147` (`mkdtemp` → `dome init` → seed files → git commit → `openVault`).
- Script wiring: `package.json` `"v1:llm-smoke": "bun scripts/v1-llm-smoke.ts"`.

## File structure

- `src/eval/types.ts` (NEW) — `EvalCase<O>`, `Assertion<O>`, `EvalResult`, `EvalReport`, `EvalEnv`.
- `src/eval/run-suite.ts` (NEW) — `runEvalSuite`.
- `src/eval/provider.ts` (NEW) — `scriptedRecordingStep` (hermetic, records trajectory) + `hermeticEvalEnv` / `liveEvalEnv` builders.
- `src/eval/assertions.ts` (NEW) — `briefShapeValid`, `trajectoryReadsBeforeWrites` factories.
- `src/eval/cases/brief.ts` (NEW) — the brief `EvalCase` (materialize vault → openVault w/ scripted step provider → sync → read daily note → `{brief, trajectory}`).
- `src/eval/cases/index.ts` (NEW) — the case registry (`ALL_EVAL_CASES`).
- `scripts/eval.ts` (NEW) + `package.json` (MODIFY) — the `bun run eval` CLI.
- `src/engine/host/vault-runtime.ts` + `src/vault.ts` (MODIFY) — the `modelStepProvider` override (Task 1).
- `tests/eval/run-suite.test.ts`, `tests/eval/assertions.test.ts`, `tests/eval/provider.test.ts` (NEW) — harness unit tests.
- `tests/fixtures/eval/brief-basic/` (NEW) — seed vault content + scripted script + expected fragment.

Execute in order; Task 1 unblocks Task 5. Tasks 1 and 5 are RISKY (SDK change; real-engine wiring) → per-task review. Tasks 2/3/4/6 are mechanical → tests-green + diff check.

---

### Task 1: `modelStepProvider` override on the vault-open path

**Files:**
- Modify: `src/engine/host/vault-runtime.ts` (the `OpenVaultRuntimeOpts` types ~178/239, the provider resolution ~422-427, attach to the runtime ~168), `src/vault.ts` (`OpenVaultOptions` + pass-through).
- Test: `tests/engine/model-step-provider-override.test.ts` (new) or extend an existing vault-runtime test.

**Interfaces:**
- Produces: `OpenVaultRuntimeOpts` and `OpenVaultOptions` gain `readonly modelStepProvider?: ModelStepProvider | undefined`. Resolution becomes `const modelStepProvider = opts.modelStepProvider ?? builtProviders?.step;` (override wins, exactly like the text path). `ModelStepProvider` is the existing type carrying `step?: ModelStepFn` (grep its definition near `src/core/processor.ts:416` / wherever `builtProviders.step` is typed).

**Why:** Brief is a tool-calling agent that runs `ctx.modelInvoke.step`. Today the step provider is built only from vault config, so an eval can't inject a scripted (offline) step provider through the real engine — only the text provider is overridable. This adds the symmetric override; it is reusable by any hermetic engine-level agent test, not eval-only.

- [ ] **Step 1: Read** `src/engine/host/vault-runtime.ts` around the provider resolution (~415-430) and the `OpenVaultRuntimeOpts` union (~170-260), and `src/vault.ts` `openVault`/`OpenVaultOptions` (~290-336). Confirm the exact type of `builtProviders.step` (the `ModelStepProvider`) and where it attaches to the `VaultRuntime` (~168).

- [ ] **Step 2: Write the failing test** (`tests/engine/model-step-provider-override.test.ts`): open a temp vault (init + commit, no model-provider config or a stub one) with `openVaultRuntime({ ..., modelStepProvider: <scripted> })`, run a tiny model-invoke-step path (reuse an existing `test.model-invoke-flow` fixture processor — grep `model-invoke-flow` under `tests/`), and assert the SCRIPTED step provider was called (not the config-built one / not network). Run, expect FAIL (`modelStepProvider` not accepted).

- [ ] **Step 3: Implement** — add `modelStepProvider?: ModelStepProvider` to both `OpenVaultRuntimeOpts` shapes and `OpenVaultOptions`; change the resolution line to `const modelStepProvider = input.opts.modelStepProvider ?? builtProviders?.step;`; thread `opts.modelStepProvider` through `openVault` → `openVaultRuntime`. Keep the config-built default when the override is absent (behavior-preserving for every existing caller).

- [ ] **Step 4: Run** `bun test ./tests/engine/model-step-provider-override.test.ts ./tests/engine ./tests` — confirm the new test passes AND no existing vault-runtime/engine test regressed (the default path is unchanged).

- [ ] **Step 5: Commit** `git add src/engine/host/vault-runtime.ts src/vault.ts tests/engine/model-step-provider-override.test.ts && git commit -m "feat(engine): modelStepProvider override on the vault-open path (symmetric with text provider)\n\nEnables hermetic injection of a scripted tool-calling provider through the real\nengine — the seam the EvalHarness needs to run agents offline. Default (config-\nbuilt) provider unchanged when the override is absent.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 2: Harness core — types + `runEvalSuite`

**Files:**
- Create: `src/eval/types.ts`, `src/eval/run-suite.ts`
- Test: `tests/eval/run-suite.test.ts`

**Interfaces:**
- Produces (consumed by all later tasks):
  - `EvalCase<O> = { readonly name: string; readonly run: (env: EvalEnv) => Promise<O>; readonly assertions: ReadonlyArray<Assertion<O>> }`
  - `Assertion<O> = (output: O) => string | null | Promise<string | null>`
  - `EvalResult = { readonly case: string; readonly failures: ReadonlyArray<string> }`
  - `EvalReport = { readonly results: ReadonlyArray<EvalResult>; readonly passed: number; readonly failed: number }`
  - `EvalEnv = { readonly modelStepProvider: ModelStepProvider; readonly mode: "hermetic" | "live" }`
  - `runEvalSuite(cases: ReadonlyArray<EvalCase<unknown>>, opts: { env: EvalEnv; log?: (line: string) => void }): Promise<EvalReport>`

- [ ] **Step 1: Write the failing test** (`tests/eval/run-suite.test.ts`):

```typescript
import { describe, expect, test } from "bun:test";
import { runEvalSuite } from "../../src/eval/run-suite";
import type { EvalCase, EvalEnv } from "../../src/eval/types";

const ENV = { modelStepProvider: { step: async () => ({ text: "x" }) }, mode: "hermetic" as const } satisfies EvalEnv;

describe("runEvalSuite", () => {
  test("reports per-case failures, awaits async assertions, survives a throwing run/assertion", async () => {
    const cases: EvalCase<number>[] = [
      { name: "passes", run: async () => 1, assertions: [(o) => (o === 1 ? null : "bad"), async (o) => (o > 0 ? null : "neg")] },
      { name: "fails-sync", run: async () => 2, assertions: [(o) => (o === 1 ? null : `got ${o}`)] },
      { name: "fails-async", run: async () => 3, assertions: [async () => "always"] },
      { name: "run-throws", run: async () => { throw new Error("boom"); }, assertions: [() => null] },
      { name: "assertion-throws", run: async () => 4, assertions: [() => { throw new Error("kaboom"); }] },
    ];
    const report = await runEvalSuite(cases as EvalCase<unknown>[], { env: ENV });
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(4);
    const byName = Object.fromEntries(report.results.map((r) => [r.case, r.failures]));
    expect(byName["passes"]).toEqual([]);
    expect(byName["fails-sync"]).toEqual(["got 2"]);
    expect(byName["fails-async"]).toEqual(["always"]);
    expect(byName["run-throws"]?.[0]).toContain("boom");
    expect(byName["assertion-throws"]?.[0]).toContain("kaboom");
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `bun test ./tests/eval/run-suite.test.ts` ("Cannot find module").

- [ ] **Step 3: Implement `src/eval/types.ts`** (the type block above, plus import `ModelStepProvider` from `../core/processor`), and **`src/eval/run-suite.ts`**:

```typescript
// src/eval/run-suite.ts
import type { EvalCase, EvalEnv, EvalReport, EvalResult } from "./types";

export async function runEvalSuite(
  cases: ReadonlyArray<EvalCase<unknown>>,
  opts: { readonly env: EvalEnv; readonly log?: (line: string) => void },
): Promise<EvalReport> {
  const log = opts.log ?? (() => {});
  const results: EvalResult[] = [];
  for (const c of cases) {
    const failures: string[] = [];
    let output: unknown;
    try {
      output = await c.run(opts.env);
    } catch (e) {
      failures.push(`run threw: ${e instanceof Error ? e.message : String(e)}`);
      results.push({ case: c.name, failures });
      log(`✗ ${c.name}: ${failures[0]}`);
      continue;
    }
    for (const assertion of c.assertions) {
      try {
        const reason = await assertion(output);
        if (reason !== null) failures.push(reason);
      } catch (e) {
        failures.push(`assertion threw: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    results.push({ case: c.name, failures });
    log(failures.length === 0 ? `✓ ${c.name}` : `✗ ${c.name}: ${failures.join("; ")}`);
  }
  const failed = results.filter((r) => r.failures.length > 0).length;
  return { results, passed: results.length - failed, failed };
}
```

- [ ] **Step 4: Run, expect PASS** — `bun test ./tests/eval/run-suite.test.ts`.

- [ ] **Step 5: Commit** `git add src/eval/types.ts src/eval/run-suite.ts tests/eval/run-suite.test.ts && git commit -m "feat(eval): EvalCase/Assertion/runEvalSuite harness core\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 3: Hermetic scripted recording provider + env builders

**Files:**
- Create: `src/eval/provider.ts`
- Test: `tests/eval/provider.test.ts`

**Interfaces:**
- Consumes: `EvalEnv` (Task 2), `ModelStepFn`/`ModelStepResult`/`ModelStepProvider` (`src/core/processor.ts`).
- Produces:
  - `type ToolCallTrace = { readonly step: number; readonly toolCalls: ReadonlyArray<{ name: string }>; readonly text: string | null }`
  - `function scriptedRecordingStep(script: ReadonlyArray<ModelStepResult>): { provider: ModelStepProvider; trajectory: ToolCallTrace[] }` — returns scripted steps in order (a `{ text: "done" }` after the script ends) AND records each into `trajectory`.
  - `function hermeticEvalEnv(script: ReadonlyArray<ModelStepResult>): { env: EvalEnv; trajectory: ToolCallTrace[] }`
  - `function liveEvalEnv(): EvalEnv` — builds the real Anthropic step provider (the `createRealLLMHarness`/config path); throws loudly if `ANTHROPIC_API_KEY` is unset (no silent hermetic fallback).

- [ ] **Step 1: Write the failing test** (`tests/eval/provider.test.ts`): `scriptedRecordingStep([{ toolCalls: [{ id:"1", name:"search_vault", input:{} }] }, { text: "final" }])` — call `provider.step(...)` twice; assert it returns the scripted results in order, a 3rd call returns `{ text: "done" }`, and `trajectory` records `[{step:0, toolCalls:[{name:"search_vault"}], text:null}, {step:1, toolCalls:[], text:"final"}]`. Run, expect FAIL.

- [ ] **Step 2: Implement `src/eval/provider.ts`** — `scriptedRecordingStep` closes over an index, pushes a `ToolCallTrace` per call (mapping `result.toolCalls?.map(c => ({name: c.name})) ?? []`), returns the scripted `ModelStepResult` (or `{ text: "done" }` past the end). `hermeticEvalEnv` wraps it into `{ modelStepProvider: provider, mode: "hermetic" }`. `liveEvalEnv` builds the real provider via the existing config/`createRealLLMHarness` path and throws if no key. (Read how `createRealLLMHarness`/`modelProviderFromConfig` builds the anthropic step provider; reuse it — do not hand-roll an Anthropic client.)

- [ ] **Step 3: Run, expect PASS** — `bun test ./tests/eval/provider.test.ts`.

- [ ] **Step 4: Commit** `git add src/eval/provider.ts tests/eval/provider.test.ts && git commit -m "feat(eval): hermetic scripted recording step provider + env builders\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 4: Assertions — `briefShapeValid` + `trajectoryReadsBeforeWrites`

**Files:**
- Create: `src/eval/assertions.ts`
- Test: `tests/eval/assertions.test.ts`

**Interfaces:**
- Consumes: `Assertion` (Task 2), `ToolCallTrace` (Task 3).
- Produces:
  - `type BriefOutput = { readonly brief: string; readonly trajectory: ReadonlyArray<ToolCallTrace> }`
  - `function briefShapeValid(opts?: { maxChars?: number }): Assertion<BriefOutput>` — fails unless the brief markdown has front-matter `type: daily`, contains the `## Open Loops` heading, contains at least one `dome.agent.brief:` marker block, and body length ≤ `maxChars` (default a generous budget, e.g. 20000).
  - `function trajectoryReadsBeforeWrites(opts: { readNames: readonly string[]; writeNames: readonly string[] }): Assertion<BriefOutput>` — fails if any write-tool call appears at a step before the first read-tool call. (Read/write tool names are passed in, not hardcoded — keeps the assertion agent-agnostic.)

- [ ] **Step 1: Write the failing test** (`tests/eval/assertions.test.ts`): a valid `BriefOutput` fixture passes `briefShapeValid()`; one missing front-matter / missing `## Open Loops` / over budget each fails with a clear reason. For trajectory: a trace with a read before a write passes; a write-before-any-read fails. Run, expect FAIL.

- [ ] **Step 2: Implement `src/eval/assertions.ts`** — pure string/array checks; each returns `null` or a specific reason string. No I/O.

- [ ] **Step 3: Run, expect PASS** — `bun test ./tests/eval/assertions.test.ts`.

- [ ] **Step 4: Commit** `git add src/eval/assertions.ts tests/eval/assertions.test.ts && git commit -m "feat(eval): briefShapeValid + trajectoryReadsBeforeWrites assertions\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 5: The brief case + golden-vault fixture (real-engine run)

**Files:**
- Create: `src/eval/cases/brief.ts`, `src/eval/cases/index.ts`, `tests/fixtures/eval/brief-basic/` (seed vault content + the scripted script).
- Test: covered by `bun run eval` (Task 6) + a focused `tests/eval/brief-case.test.ts` that runs the case hermetically and asserts it passes.

**Interfaces:**
- Consumes: `EvalCase`/`EvalEnv` (Task 2), `hermeticEvalEnv` is built by the CLI (Task 6) — but the case's `run(env)` uses `env.modelStepProvider`; `briefShapeValid`/`trajectoryReadsBeforeWrites` (Task 4); `openVault` + `modelStepProvider` override (Task 1).
- Produces: `briefCase: EvalCase<BriefOutput>`; `ALL_EVAL_CASES: ReadonlyArray<EvalCase<unknown>>` in `cases/index.ts`.

- [ ] **Step 1: Read brief's trigger + output precisely** — `assets/extensions/dome.agent/processors/brief.ts` trigger declaration (schedule cron vs signal-on-source-file) and the exact daily path + marker blocks + the deterministic skeleton. Decide the trigger mechanism for a deterministic `sync()` run (PRIMARY: seed the fixture so brief's SIGNAL trigger fires on sync — i.e. a new calendar/slack source file in the watched path, committed; the brief then runs during `vault.sync()`). Read `scripts/v1-llm-smoke.ts` for the temp-vault init+seed+commit+openVault pattern and reuse it.

- [ ] **Step 2: Build the fixture** `tests/fixtures/eval/brief-basic/` — the minimal seeded vault files that (a) make brief's trigger fire on sync and (b) give the brief agent groundable inputs (e.g. a small `core.md`, a calendar/slack source file with one item carrying a `[[wikilink]]`-able entity). Plus a `script.ts`/`script.json` = the scripted `ModelStepResult[]` the brief agent will receive (tool calls that read the seeded inputs then emit a grounded bullet, then a final text). Keep it minimal but realistic.

- [ ] **Step 3: Implement `src/eval/cases/brief.ts`** — `run(env)`:
  1. `mkdtemp` a vault dir; copy the fixture files in; `dome init` (or the programmatic init used by the smoke script) + git commit (reuse the smoke-script helpers — extract a shared `materializeFixtureVault(fixtureDir): Promise<string>` helper if clean, else inline).
  2. `const vault = await openVault({ path, modelStepProvider: env.modelStepProvider })`.
  3. `await vault.sync()` (brief fires via its trigger).
  4. `const doc = await vault.readDocument("wiki/dailies/<fixed-date>.md")` — capture `brief = doc.content`. (Pin the date deterministically — the fixture/firedAt controls it; if brief uses wall-clock, the case must pin the clock the same way brief tests do — read how `brief.test.ts` pins `FIRED_AT`.)
  5. `await vault.close()`; return `{ brief, trajectory }` where `trajectory` comes from the `hermeticEvalEnv` recorder (thread the recorder's `trajectory` array into the case — the CLI builds env+trajectory together and the case reads `env`-attached trajectory; simplest: `hermeticEvalEnv` stores the trajectory on the provider object and the case reads it back, OR the case is constructed with the trajectory ref. Pick the cleaner wiring while implementing and note it.)
  - Assertions: `[briefShapeValid(), trajectoryReadsBeforeWrites({ readNames: [<brief read tools>], writeNames: [<brief write tools>] })]` — read the actual brief tool names from `brief.ts`/its tool set.

  **FALLBACK (document if used):** if signal-triggering brief deterministically through `sync()` proves flaky or infeasible in the time available, the case may instead drive brief through the runtime's processor path with `env.modelStepProvider` (still real registry + broker + effect application via `openVaultRuntime`, just invoking the brief processor directly rather than via the scheduler) and read the resulting adopted doc. This still closes most of the wiring gap. STOP and report which path you took; do NOT silently fall back to a pure `brief.run(ctx)` unit-style call (that's the gap we're closing).

- [ ] **Step 4: Implement `src/eval/cases/index.ts`** — `export const ALL_EVAL_CASES = [briefCase];`

- [ ] **Step 5: Mutation-fence** — if `brief.ts` (the case) calls `mkdir`/`writeFile`/`cp` directly to materialize the fixture vault (outside the vault APIs), add `src/eval/cases/brief.ts` (and any shared materialize helper's file) to `tests/integration/no-direct-mutation-outside-boundaries.test.ts` ALLOWED_FILES with a comment ("eval harness materializes a throwaway temp vault from a fixture — not a vault write path"). Confirm that fence test passes.

- [ ] **Step 6: Write + run the focused case test** (`tests/eval/brief-case.test.ts`): build `hermeticEvalEnv` from the fixture script, run `briefCase.run(env)`, assert the returned `brief` is non-empty and both assertions pass (reason === null). Run `bun test ./tests/eval/brief-case.test.ts ./tests/integration/no-direct-mutation-outside-boundaries.test.ts`. Then run the FULL suite `bun test ./tests` to confirm no regression.

- [ ] **Step 7: Commit** `git add src/eval/cases/ tests/eval/brief-case.test.ts tests/fixtures/eval/ tests/integration/no-direct-mutation-outside-boundaries.test.ts && git commit -m "feat(eval): brief golden case run through the real engine (hermetic)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 6: The `bun run eval` CLI

**Files:**
- Create: `scripts/eval.ts`
- Modify: `package.json` (add `"eval": "bun scripts/eval.ts"`).

**Interfaces:**
- Consumes: `ALL_EVAL_CASES` (Task 5), `runEvalSuite` (Task 2), `hermeticEvalEnv`/`liveEvalEnv` (Task 3).

- [ ] **Step 1: Implement `scripts/eval.ts`** (`#!/usr/bin/env bun`): parse `--live` from argv; build the env — hermetic from each case's fixture script (the CLI/cases own the script; simplest: each case carries its own hermetic script internally and the CLI just builds a base env, OR the CLI builds `hermeticEvalEnv` per case — pick the wiring consistent with Task 5's trajectory threading); call `runEvalSuite(ALL_EVAL_CASES, { env, log: console.log })`; `process.exit(report.failed > 0 ? 1 : 0)`. On `--live`, use `liveEvalEnv()` (throws loudly without a key). Mirror the `scripts/v1-llm-smoke.ts` structure (`async function main()` + `.catch(e => { console.error(e); process.exit(1); })`).

- [ ] **Step 2: Add the package.json script** — `"eval": "bun scripts/eval.ts"` in the `scripts` block (do NOT add to `v1:check`).

- [ ] **Step 3: Run `bun run eval`** — expect green (the brief case passes hermetically), exit 0. Then sanity-check the guard bites: temporarily corrupt the fixture script so `briefShapeValid` fails, re-run, confirm `bun run eval` exits non-zero and names the failure; REVERT the corruption.

- [ ] **Step 4: Run the full suite** `bun test ./tests` — confirm green (the CLI addition didn't disturb anything).

- [ ] **Step 5: Commit** `git add scripts/eval.ts package.json && git commit -m "feat(eval): bun run eval CLI (hermetic default, --live swap)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

## Self-Review

**Spec coverage:** harness core (EvalCase/Assertion/runEvalSuite) → Task 2 ✓. Provider seam hermetic/live → Task 3 + the Task 1 SDK override that makes hermetic-through-the-engine possible ✓. Golden-vault fixture + brief case run through the real engine → Task 5 ✓. Assertions (briefShapeValid + trajectory) → Task 4 ✓. `bun run eval`, hermetic-default, not in `v1:check` → Task 6 ✓. Error handling (run/assertion throws → failure not crash; live-no-key fails loudly) → Task 2 (runSuite catches) + Task 3 (liveEvalEnv throws) ✓. Harness unit test → Task 2; brief is the first real eval → Tasks 5/6 ✓. Extensibility seams → preserved (core is agent-agnostic; assertions take tool names as params; cases/index is the registry) ✓.

**Placeholder scan:** Tasks 1 and 5 instruct reading current code (the provider-resolution site; brief's trigger/output/tool-names/clock-pinning) before transforming, with PRIMARY approach + a documented FALLBACK + STOP-and-report guidance — the right granularity for engine-integration work whose exact mechanism must be read from the live code, not guessed. Tasks 2/3/4 carry complete code. The brief fixture content (Task 5 Step 2) is necessarily authored against the real brief contract by the implementer (it depends on brief's exact tool set + trigger), not pre-fabricated here — flagged explicitly, not silently.

**Type consistency:** `EvalCase<O>`/`Assertion<O>`/`EvalEnv`/`EvalReport` defined in Task 2, consumed unchanged in 3/4/5/6. `ToolCallTrace` defined in Task 3, used by `BriefOutput` in Task 4. `BriefOutput` defined in Task 4, produced by Task 5's case. `modelStepProvider` override (Task 1) consumed in Task 5's `openVault` call. `ModelStepProvider`/`ModelStepResult`/`ModelStepFn` are existing engine types (`src/core/processor.ts`). No drift.

**Risk gating:** Task 1 (SDK provider-resolution change) and Task 5 (real-engine wiring + fixture authoring + trajectory threading) are RISKY → per-task review. Tasks 2/3/4/6 → tests-green + diff check, swept by the final whole-branch review.
