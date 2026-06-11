# Review Hardening (Items 1–4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the four P1 items from the 2026-06-10 architecture review: spec count-drift fixes pinned by a lockstep test, quarantine-recovery stale-check parity with its outbox/run siblings, machine-checked `enforced_by:` links from invariant docs to their behavioral tests, and LLM prompt-regression + provider-failure coverage.

**Architecture:** Pure additive hardening — no behavior changes outside the quarantine-recovery diagnostic. Each task is TDD-shaped: write the failing fence first, then make the substrate satisfy it. Doc edits and code edits land in the same commit as the test that pins them.

**Tech Stack:** Bun + bun:test (snapshots), zod 4 (`EffectSchema.options` / `CapabilitySchema.options` as canonical counts), gray-matter (frontmatter parsing in tests), the existing scenario harness (`tests/harness/`).

**Branch:** `worktree-review-hardening+build` (worktree at `.claude/worktrees/review-hardening+build`). Merge flow per repo convention: `--no-ff` into `main` when done.

**Verified facts this plan relies on** (re-verified 2026-06-10):
- `EffectSchema` is an 11-member `z.discriminatedUnion` at `src/core/effect.ts:716-728`.
- `CapabilitySchema` is a 17-member `z.discriminatedUnion` at `src/core/processor.ts:923-941`.
- `clearQuarantineIfCurrent` **already returns `boolean`** (`src/processors/execution-state.ts:52-54`); only the sink plumbing discards it.
- The outbox/run stale-check pattern to mirror is at `src/engine/core/apply-effect.ts:690-742`; codes `outbox-recovery.stale-or-missing`, `run-recovery.stale-or-missing`.
- Harness scenarios accept `modelProvider` (`tests/harness/types.ts:106`); `ModelProvider = (req: { prompt, model?, temperature?, signal }) => Promise<{ text, model?, costUsd? }>` (`src/engine/core/model-invoke.ts:31-45`).
- `dome.warden.integrity` is a garden processor triggered by `document.changed` on `wiki/**/*.md` with `model.invoke` (`assets/extensions/dome.warden/manifest.yaml`).
- Charters: `BRIEF_CHARTER`, `INGEST_CHARTER` (const), `consolidateCharter({ledgerPath, maxChangedFiles})`, `sweepCharter({destination, material, materialDate})` (functions) under `assets/extensions/dome.agent/lib/`.

---

### Task 1: Substrate-counts lockstep test (write the failing fence)

**Files:**
- Create: `tests/integration/substrate-counts.test.ts`

- [ ] **Step 1: Write the test**

```ts
// tests/integration/substrate-counts.test.ts
//
// Lockstep fence for the substrate-count-drift gotcha
// (docs/wiki/gotchas/substrate-count-drift.md): the spelled-out counts in
// normative docs must agree with the canonical const unions in src/core/
// (effect kinds, capability tiers) or with each other (contribution kinds,
// sync-outcome enumerations).

import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { EffectSchema } from "../../src/core/effect";
import { CapabilitySchema } from "../../src/core/processor";

const REPO_ROOT = join(import.meta.dir, "..", "..");

const NUMBER_WORDS: Record<number, string> = {
  5: "five",
  6: "six",
  7: "seven",
  9: "nine",
  10: "ten",
  11: "eleven",
  12: "twelve",
  16: "sixteen",
  17: "seventeen",
  18: "eighteen",
};

const WORD_TO_NUMBER: Record<string, number> = Object.fromEntries(
  Object.entries(NUMBER_WORDS).map(([n, w]) => [w, Number(n)]),
);

async function doc(rel: string): Promise<string> {
  return readFile(join(REPO_ROOT, "docs", rel), "utf8");
}

test("effect kind count: docs match EffectSchema", async () => {
  const word = NUMBER_WORDS[EffectSchema.options.length];
  expect(word, "add the new count to NUMBER_WORDS").toBeDefined();
  expect((await doc("wiki/specs/effects.md")).toLowerCase()).toContain(
    `${word}-kind`,
  );
  expect((await doc("VISION.md")).toLowerCase()).toContain(`${word} kinds`);
  expect((await doc("index.md")).toLowerCase()).toContain(
    `${word}-kind effect taxonomy`,
  );
});

test("capability tier count: docs match CapabilitySchema", async () => {
  const word = NUMBER_WORDS[CapabilitySchema.options.length];
  expect(word, "add the new count to NUMBER_WORDS").toBeDefined();
  expect((await doc("wiki/specs/capabilities.md")).toLowerCase()).toContain(
    `${word} capability tiers`,
  );
  expect((await doc("index.md")).toLowerCase()).toContain(
    `${word} capability tiers`,
  );
});

test("adoption.md sync-outcome label matches its enumeration", async () => {
  const text = await doc("wiki/specs/adoption.md");
  const match = text.match(/The (\w+) outcomes:\n\n((?:- \*\*[^\n]*\n)+)/);
  expect(match, "outcomes section shape changed — update this regex").not.toBeNull();
  if (match === null) return;
  const labeled = WORD_TO_NUMBER[match[1]!.toLowerCase()];
  expect(labeled, `unknown number word '${match[1]}'`).toBeDefined();
  const bullets = match[2]!.trim().split("\n").length;
  expect(labeled).toBe(bullets);
});

test("bundle contribution-kind count agrees across docs", async () => {
  const matrix = (await doc("wiki/matrices/extension-bundle-shape.md")).toLowerCase();
  const canonical = matrix.match(/(\w+) contribution kinds/);
  expect(canonical).not.toBeNull();
  if (canonical === null) return;

  const surface = (await doc("wiki/specs/sdk-surface.md")).toLowerCase();
  const acrossClaim = surface.match(/contributions across (\w+) kinds/);
  expect(acrossClaim, "sdk-surface 'contributions across N kinds' sentence missing").not.toBeNull();
  expect(acrossClaim![1]).toBe(canonical[1]);

  const inlineClaim = surface.match(/the (\w+) contribution kinds/);
  expect(inlineClaim, "sdk-surface 'the N contribution kinds' sentence missing").not.toBeNull();
  expect(inlineClaim![1]).toBe(canonical[1]);
});
```

- [ ] **Step 2: Run it and verify it fails on exactly the three known drifts**

Run: `bun test tests/integration/substrate-counts.test.ts`
Expected: FAIL —
- "effect kind count" fails on `VISION.md` ("seven kinds" present, "eleven kinds" absent),
- "sync-outcome label" fails (label "five" vs 6 bullets),
- "contribution-kind count" fails (`contributions across five kinds` vs matrix "seven"),
- "capability tier count" PASSES (verified correct at seventeen).

If any *other* assertion fails, stop and inspect — that's either a regex mismatch against the real doc text (fix the test) or a fourth drift (note it, fix it in Task 2).

- [ ] **Step 3: Commit the red test**

```bash
git add tests/integration/substrate-counts.test.ts
git commit -m "test: substrate-counts lockstep fence (red — pins known count drift)"
```

(Committing red is deliberate here: the next commit's diff shows exactly which doc lines the fence forced.)

---

### Task 2: Spec count fixes + mcp-surface vocabulary (make Task 1 green)

**Files:**
- Modify: `docs/VISION.md:44`
- Modify: `docs/wiki/specs/adoption.md:171`
- Modify: `docs/wiki/specs/sdk-surface.md:233`
- Modify: `docs/wiki/specs/mcp-surface.md:20,53,55`

- [ ] **Step 1: Fix VISION.md line 44**

Old:
```
Effect        What a processor returns. Seven kinds; closed taxonomy.
```
New:
```
Effect        What a processor returns. Eleven kinds; closed taxonomy.
```

- [ ] **Step 2: Fix adoption.md line 171**

Old: `The five outcomes:`
New: `The six outcomes:`

- [ ] **Step 3: Fix sdk-surface.md line 233 (end of the paragraph)**

Old:
```
The bundle contains a `manifest.yaml` plus contributions across five kinds: page-types, preamble, processors, capabilities, external-handlers.
```
New:
```
The bundle contains a `manifest.yaml` plus contributions across seven kinds: page-types, preamble, processors, external-handlers, capability-grants, loops, and doctor grant-entry probes.
```

- [ ] **Step 4: Disambiguate mcp-surface.md retired-vocabulary hits**

The `no-retired-symbol-names` linter forbids `Tool`/`Workflow` *as Dome-primitive concepts*; these lines use MCP-protocol vocabulary that a future regex sweep would still hit. Disambiguate:

- Line 20, old: `2. **Workflows that benefit from typed argument validation.** MCP routes the same operations...`
  New: `2. **Flows that benefit from typed argument validation.** MCP routes the same operations...`
- Line 53, old: `Tool names are bare verbs — harness clients already namespace...`
  New: `MCP tool names are bare verbs — harness clients already namespace...`
- Line 55 (table header), old: `| Tool | Same path as | Result schema | Purpose |`
  New: `| MCP tool | Same path as | Result schema | Purpose |`

Then sweep the rest of the file for any remaining bare-`Tool`/`Workflow` normative usage:
Run: `grep -n "Tool\|Workflow" docs/wiki/specs/mcp-surface.md`
Expected: every remaining hit is either `MCP tool`, a tool *name* in a table row, or inside a historical/migration context. Prefix any stragglers with `MCP `.

- [ ] **Step 5: Verify the fence is green**

Run: `bun test tests/integration/substrate-counts.test.ts`
Expected: PASS (4 pass, 0 fail)

- [ ] **Step 6: Full-suite sanity for the docs change** (the docs dir is a Dome vault; other lockstep tests walk it)

Run: `bun test tests/integration`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add docs/VISION.md docs/wiki/specs/adoption.md docs/wiki/specs/sdk-surface.md docs/wiki/specs/mcp-surface.md
git commit -m "docs: fix substrate count drift (eleven effects, six outcomes, seven contribution kinds) + MCP-tool vocabulary"
```

---

### Task 3: Quarantine-recovery stale-check parity

`clearQuarantineIfCurrent` already returns `boolean`; the sink type (`Promise<void>`) discards it, so a stale quarantine answer reports silent success while its outbox/run siblings emit `*.stale-or-missing` warnings. Bring quarantine to parity and extract the shared stale-result helper (the "option 1" unification from the review — taxonomy untouched).

**Files:**
- Modify: `src/engine/core/apply-effect.ts` (~lines 271-276 sink type, ~391 default sink, 690-742 routing cases)
- Modify: `src/engine/host/compiler-host.ts:999-1011`
- Modify: `src/engine/host/view-command.ts:190-192`
- Modify: `src/engine/host/projection-rebuild.ts:96`
- Modify: `docs/wiki/specs/effects.md` (QuarantineRecoveryEffect routing paragraph)
- Test: `tests/engine/apply-effect.test.ts`

- [ ] **Step 1: Write the failing test**

Locate the sibling test to mirror:
Run: `grep -n "stale-or-missing" tests/engine/apply-effect.test.ts`

Copy the existing **run-recovery** stale test block verbatim into a new test in the same describe block, then apply exactly these changes:
1. Test name → `"quarantine-recovery against a stale/missing quarantine emits quarantine-recovery.stale-or-missing"`.
2. The effect under test → a `quarantine-recovery` effect (use the effect constructor / literal shape already used by the file's existing quarantine-recovery routing tests — grep `"quarantine-recovery"` in the same file for the fixture shape: `kind, action: "reset", phase, processorId, processorVersion, triggerHash, quarantineId, quarantinedAt, consecutiveRetryableFailures, reason, sourceRefs`).
3. The sink override → `recoverQuarantine: async () => false` (instead of `recoverRun: async () => false`).
4. The expected diagnostic → `code: "quarantine-recovery.stale-or-missing"`, `severity: "warning"`.

- [ ] **Step 2: Run it and verify it fails**

Run: `bun test tests/engine/apply-effect.test.ts -t "quarantine-recovery.stale"`
Expected: FAIL — TypeScript error on `recoverQuarantine: async () => false` (sink type is `Promise<void>`) or, if structurally typed through, no diagnostic emitted.

- [ ] **Step 3: Change the sink contract in `src/engine/core/apply-effect.ts`**

At ~line 271-276, old:
```ts
  readonly recoverQuarantine: (input: {
    readonly effect: QuarantineRecoveryEffect;
    readonly processorId: string;
    readonly runId: RunId;
  }) => Promise<void>;
```
New:
```ts
  /** Returns false when no current quarantine row matched the effect's
   *  generation fields — routing then emits
   *  `quarantine-recovery.stale-or-missing` instead of silent success. */
  readonly recoverQuarantine: (input: {
    readonly effect: QuarantineRecoveryEffect;
    readonly processorId: string;
    readonly runId: RunId;
  }) => Promise<boolean>;
```

At ~line 391 (test/default sinks), old: `recoverQuarantine: async () => undefined,` → New: `recoverQuarantine: async () => true,`

- [ ] **Step 4: Extract the shared stale-result helper and use it in all three recovery cases**

Add near the other module-private helpers in `apply-effect.ts`:

```ts
// The three operational-recovery effects share one stale-answer contract:
// the sink returns false when no current row matched the effect's
// generation fields, and routing surfaces that as a warning instead of
// silent success. (See docs/wiki/specs/effects.md — recovery effects.)
function staleRecoveryResult(opts: {
  readonly code: string;
  readonly message: string;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
}): { newCandidate: null; diagnostics: ReadonlyArray<DiagnosticEffect> } {
  return {
    newCandidate: null,
    diagnostics: Object.freeze([
      diagnosticEffect({
        severity: "warning",
        code: opts.code,
        message: opts.message,
        sourceRefs: opts.sourceRefs,
      }),
    ]),
  };
}
```

(If `SourceRef` is not already imported in this file, import the type from `../../core/source-ref` — check the existing imports first; `sourceRefs` fields are already handled here so it almost certainly is.)

Rewrite the three cases at ~690-742:

```ts
    case "outbox-recovery":
      if (
        !(await opts.sinks.recoverOutbox({
          effect,
          processorId: opts.processorId,
          runId: opts.runId,
        }))
      ) {
        return staleRecoveryResult({
          code: "outbox-recovery.stale-or-missing",
          message:
            `OutboxRecoveryEffect did not change row ${effect.idempotencyKey}: ` +
            "the row is no longer failed, no longer matches the question generation, or does not exist.",
          sourceRefs: effect.sourceRefs,
        });
      }
      return EMPTY_SINK_RESULT;
    case "quarantine-recovery":
      if (
        !(await opts.sinks.recoverQuarantine({
          effect,
          processorId: opts.processorId,
          runId: opts.runId,
        }))
      ) {
        return staleRecoveryResult({
          code: "quarantine-recovery.stale-or-missing",
          message:
            `QuarantineRecoveryEffect did not clear quarantine ${effect.quarantineId} ` +
            `for ${effect.processorId}@${effect.processorVersion} (${effect.phase}): ` +
            "the quarantine no longer matches the question generation or does not exist.",
          sourceRefs: effect.sourceRefs,
        });
      }
      return EMPTY_SINK_RESULT;
    case "run-recovery":
      if (
        !(await opts.sinks.recoverRun({
          effect,
          processorId: opts.processorId,
          runId: opts.runId,
        }))
      ) {
        return staleRecoveryResult({
          code: "run-recovery.stale-or-missing",
          message:
            `RunRecoveryEffect did not change run ${effect.runId}: ` +
            "the row is no longer running, no longer matches the question generation, or does not exist.",
          sourceRefs: effect.sourceRefs,
        });
      }
      return EMPTY_SINK_RESULT;
```

(The outbox/run messages are byte-identical to the current inline ones — only the construction moves into the helper.)

- [ ] **Step 5: Return the boolean through the host sinks**

`src/engine/host/compiler-host.ts:999` — old body calls `clearQuarantineIfCurrent` and discards; new:

```ts
      recoverQuarantine: async ({ effect }) =>
        runtime.processorRuntime.executionState.clearQuarantineIfCurrent({
          phase: effect.phase,
          processorId: effect.processorId,
          processorVersion: effect.processorVersion,
          triggerHash: effect.triggerHash,
          quarantineId: effect.quarantineId,
          quarantinedAt: new Date(effect.quarantinedAt),
          consecutiveRetryableFailures: effect.consecutiveRetryableFailures,
        }),
```

`src/engine/host/view-command.ts:190-192`, old:
```ts
  const recoverQuarantine: ApplyEffectSinks["recoverQuarantine"] =
    async () => undefined;
```
New (view phase rejects the effect before the sink runs; `true` preserves no-op semantics):
```ts
  const recoverQuarantine: ApplyEffectSinks["recoverQuarantine"] =
    async () => true;
```

`src/engine/host/projection-rebuild.ts:96`, old: `recoverQuarantine: async () => undefined,` → New: `recoverQuarantine: async () => true,`

Also check the delegating wrapper at `src/engine/host/compiler-host.ts:1069` (`recoverQuarantine: async (input) => current().recoverQuarantine(input)`) — it forwards the return value already once the types change; no edit needed beyond typecheck.

- [ ] **Step 6: Typecheck + run the engine tests**

Run: `bunx tsc --noEmit` (or the repo's typecheck script — check `package.json` `scripts`; use that if one exists)
Expected: clean. Any remaining `recoverQuarantine` implementor the compiler flags gets the same `() => true` treatment.

Run: `bun test tests/engine/apply-effect.test.ts`
Expected: PASS, including the new stale test.

- [ ] **Step 7: Update the spec text**

In `docs/wiki/specs/effects.md`, QuarantineRecoveryEffect **Routing** paragraph, after the sentence ending "…cannot clear a later re-quarantine for the same trigger.", append:

```
If the sink finds no matching current quarantine, routing records a
`quarantine-recovery.stale-or-missing` warning diagnostic instead of silently
reporting success — the same stale-answer contract as outbox and run recovery.
```

- [ ] **Step 8: Run the recovery scenarios + full engine suite**

Run: `bun test tests/engine tests/harness/scenarios/effect-routing`
Expected: PASS (the health-quarantine-recovery scenario exercises the happy path end-to-end and must be unaffected).

- [ ] **Step 9: Commit**

```bash
git add src/engine/core/apply-effect.ts src/engine/host/compiler-host.ts src/engine/host/view-command.ts src/engine/host/projection-rebuild.ts tests/engine/apply-effect.test.ts docs/wiki/specs/effects.md
git commit -m "fix(engine): quarantine-recovery stale answers emit stale-or-missing diagnostic (parity with outbox/run recovery)"
```

**Banked decision (do NOT implement on this branch):** merging the three recovery kinds into one `OperationalRecoveryEffect` (taxonomy 11→9). With this task the three kinds now share one routing contract, which makes the later merge mechanical if chosen. Record the open decision in the relevant brainstorm/ledger doc if the repo convention calls for it.

---

### Task 4: `enforced_by:` invariant lockstep

Invariant docs become navigable: each non-deferred invariant lists the behavioral test files that actually enforce it, and `invariant-coverage.test.ts` verifies those paths exist.

**Files:**
- Modify: `tests/integration/invariant-coverage.test.ts`
- Modify: all 19 files in `docs/wiki/invariants/*.md` (frontmatter only; deferred-tier docs exempt)
- Modify: `docs/wiki/specs/sdk-surface.md` §"Adding a new invariant" (recipe gains one item)

- [ ] **Step 1: Extend the coverage test**

In `tests/integration/invariant-coverage.test.ts`, inside the existing per-invariant `test(...)`, after the existing `existsSync(testPath)` assertion, add:

```ts
      const enforcedBy = (fm as { enforced_by?: unknown }).enforced_by;
      expect(
        Array.isArray(enforcedBy) && enforcedBy.length > 0,
        `invariant ${name} (tier: ${tier}) requires 'enforced_by:' frontmatter — ` +
          `a non-empty list of repo-relative test files that behaviorally enforce it. ` +
          `The tests/invariants/ marker is the lockstep anchor; enforced_by names the real coverage.`,
      ).toBe(true);
      for (const entry of enforcedBy as ReadonlyArray<unknown>) {
        expect(typeof entry, `${name} enforced_by entries must be strings`).toBe("string");
        expect(
          existsSync(join(REPO_ROOT, entry as string)),
          `invariant ${name} enforced_by path does not exist: ${entry}`,
        ).toBe(true);
      }
```

And widen the frontmatter cast where `fm` is read: `as { tier?: string; enforced_by?: unknown }`.

- [ ] **Step 2: Run it and verify it fails for every non-deferred invariant**

Run: `bun test tests/integration/invariant-coverage.test.ts`
Expected: FAIL — one failure per non-deferred invariant doc, each naming the doc that needs `enforced_by:`.

- [ ] **Step 3: Add `enforced_by:` frontmatter to each invariant doc**

Add a block like this to each doc's frontmatter (after `tier:`):

```yaml
enforced_by:
  - tests/engine/capability-broker.test.ts
  - tests/engine/apply-effect.test.ts
```

Starting mapping (verify each path with `ls <path>` before committing; where a path is wrong or you want better coverage, locate the real test with the grep given per row — the extended test fails loudly on any wrong path, so nothing wrong can land):

| Invariant doc | enforced_by (starting list) | If missing, locate via |
|---|---|---|
| ADOPTED_REF_IS_SEMANTIC_CURSOR | `tests/harness/scenarios/cli-surface/reanchor-divergence.scenario.test.ts`, `tests/cli/sync.test.ts` | `grep -rl "reanchor\|fast-forward" tests/` |
| AGENTS_MD_IS_ORIENTATION_SURFACE | (locate) | `grep -rl "agents-md\|AGENTS.md" tests/ \| head` |
| ALL_MUTATION_GOES_THROUGH_ADOPTION | `tests/integration/no-direct-mutation-outside-boundaries.test.ts` | `ls tests/integration/ \| grep -i mutation` |
| EMBEDDINGS_ARE_A_RECOMPUTABLE_CACHE | *(tier: deferred — exempt, skip)* | — |
| ENGINE_COMMITS_CARRY_DOME_TRAILERS | `tests/engine/finalize-journal.test.ts` + one trailer scenario | `grep -rln "Dome-Run" tests/harness/scenarios/ \| head -3` |
| ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY | `tests/integration/bundle-deps.test.ts` | — |
| ENGINE_IS_THE_ONLY_APPLIER | `tests/integration/no-direct-mutation-outside-boundaries.test.ts`, `tests/engine/apply-effect.test.ts` | `ls tests/integration/ \| grep -i "applier\|mutation"` |
| EVERY_EFFECT_IS_CAPABILITY_CHECKED | `tests/engine/capability-broker.test.ts`, `tests/engine/apply-effect.test.ts` | — |
| EVERY_EFFECT_IS_LEDGERED | `tests/engine/apply-effect.test.ts`, `tests/ledger/runs.test.ts` | — |
| EVERY_PROCESSOR_RUN_IS_LEDGERED | `tests/ledger/runs.test.ts`, `tests/processors/runtime.test.ts` | `ls tests/processors/` |
| EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX | `tests/outbox/dispatch.test.ts`, `tests/harness/scenarios/effect-routing/health-outbox-recovery.scenario.test.ts` | — |
| INBOX_IS_EPHEMERAL | (locate — the inbox-stale-check processor test) | `grep -rl "inbox.stale\|inbox-stale" tests/` |
| LOG_IS_APPEND_ONLY | check tier first (`head docs/wiki/invariants/LOG_IS_APPEND_ONLY.md`) — "axiom target" may be `tier: deferred`; if so, exempt | — |
| MARKDOWN_IS_SOURCE_OF_TRUTH | `tests/harness/scenarios/cli-surface/rebuild-projection.scenario.test.ts` | — |
| MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS | (locate — manifest capability×phase rejection + agent-bundle grant checks) | `grep -rl "model.invoke" tests/extensions/loader.test.ts tests/integration/` |
| PROJECTIONS_ARE_REBUILDABLE | `tests/harness/scenarios/cli-surface/rebuild-projection.scenario.test.ts`, `tests/projections/` (name the specific rebuild test file) | `ls tests/projections/` |
| PROPOSALS_ARE_THE_ONLY_WRITE_PATH | (locate — public-surface shape test asserting no submitProposal export) | `grep -rln "submitProposal\|public surface" tests/ \| head -3` |
| RAW_IS_IMMUTABLE | `tests/engine/capability-broker.test.ts` (raw-path denial) + the dome.markdown raw-immutable processor test | `grep -rl "raw-immutable" tests/` |
| VAULT_IS_GIT_REPO | `tests/git.test.ts` (and the openVault not-a-vault test) | `grep -rln "not-a-vault" tests/ \| head -3` |

- [ ] **Step 4: Iterate until green**

Run: `bun test tests/integration/invariant-coverage.test.ts`
Expected: PASS. Re-run after each batch of docs; the failure messages name exactly what's left.

- [ ] **Step 5: Update the recipe in sdk-surface.md**

In §"Adding a new invariant", change "Two file edits, plus the behavioral enforcement test where needed:" to "Two file edits plus frontmatter lockstep:" and append a third list item:

```
3. **Name the behavioral coverage** in the doc's frontmatter: `enforced_by:` lists the repo-relative test files that actually enforce the behavior. `tests/integration/invariant-coverage.test.ts` verifies the list is non-empty and every path exists (deferred-tier docs are exempt).
```

- [ ] **Step 6: Full integration suite + commit**

Run: `bun test tests/integration`
Expected: PASS.

```bash
git add tests/integration/invariant-coverage.test.ts docs/wiki/invariants/ docs/wiki/specs/sdk-surface.md
git commit -m "test(invariants): enforced_by frontmatter lockstep — invariant docs name their behavioral coverage"
```

---

### Task 5: Prompt-regression snapshots

Pins the `agent-prompt-regression` gotcha: charter/prompt text changes become visible diffs in review instead of silent behavior drift.

**Files:**
- Modify: `assets/extensions/dome.warden/processors/integrity.ts:188` (export `promptForPage`)
- Create: `tests/integration/agent-prompt-regression.test.ts`
- Create (generated): `tests/integration/__snapshots__/agent-prompt-regression.test.ts.snap`

- [ ] **Step 1: Export the warden prompt builder**

`assets/extensions/dome.warden/processors/integrity.ts:188`, old: `function promptForPage(path: string, content: string): string {` → New: `export function promptForPage(path: string, content: string): string {`

- [ ] **Step 2: Write the snapshot test**

```ts
// tests/integration/agent-prompt-regression.test.ts
//
// Snapshot fence for docs/wiki/gotchas/agent-prompt-regression.md: the LLM
// charters are behavior-bearing config. Any edit must show up as a snapshot
// diff in review. Intentional changes: update the prompt, run
// `bun test tests/integration/agent-prompt-regression.test.ts --update-snapshots`,
// and commit the .snap diff alongside the prompt change.

import { describe, expect, test } from "bun:test";

import { BRIEF_CHARTER } from "../../assets/extensions/dome.agent/lib/brief-charter";
import { INGEST_CHARTER } from "../../assets/extensions/dome.agent/lib/ingest-charter";
import { consolidateCharter } from "../../assets/extensions/dome.agent/lib/consolidate-charter";
import { sweepCharter } from "../../assets/extensions/dome.agent/lib/sweep-charter";
import { promptForPage } from "../../assets/extensions/dome.warden/processors/integrity";

describe("agent prompt regression", () => {
  test("dome.agent.brief charter", () => {
    expect(BRIEF_CHARTER).toMatchSnapshot();
  });

  test("dome.agent.ingest charter", () => {
    expect(INGEST_CHARTER).toMatchSnapshot();
  });

  test("dome.agent.consolidate charter (fixed inputs)", () => {
    expect(
      consolidateCharter({
        ledgerPath: "wiki/meta/consolidation-ledger.md",
        maxChangedFiles: 25,
      }),
    ).toMatchSnapshot();
  });

  test("dome.agent.sweep charter (fixed inputs)", () => {
    expect(
      sweepCharter({
        destination: "wiki/entities/acme.md",
        material: "inbox/raw/2026-06-01-standup.md",
        materialDate: "2026-06-01",
      }),
    ).toMatchSnapshot();
  });

  test("dome.warden.integrity page prompt (fixed inputs)", () => {
    expect(
      promptForPage("wiki/entities/acme.md", "# Acme\n\nA company we work with.\n"),
    ).toMatchSnapshot();
  });
});
```

Note: if any import name above doesn't resolve, check the actual export with `grep -n "^export" <file>` and adjust — the charter modules were verified to export `BRIEF_CHARTER`, `INGEST_CHARTER`, `consolidateCharter(opts)`, `sweepCharter(opts)` as of plan-writing. If `consolidateCharter`'s default `maxChangedFiles` is sourced from a constant, prefer importing and passing that constant so the snapshot tracks the shipped value.

- [ ] **Step 3: Generate snapshots, then verify stability**

Run: `bun test tests/integration/agent-prompt-regression.test.ts`
Expected: PASS, 5 snapshots written.
Run it **again**: Expected: PASS with 0 new snapshots (proves the fixed inputs are deterministic).

- [ ] **Step 4: Confirm no fence breakage from the new export**

Run: `bun test tests/integration/processor-purity.test.ts tests/extensions`
Expected: PASS (exporting a pure string builder from a processor module must not trip purity checks).

- [ ] **Step 5: Commit (including the .snap file)**

```bash
git add tests/integration/agent-prompt-regression.test.ts tests/integration/__snapshots__ assets/extensions/dome.warden/processors/integrity.ts
git commit -m "test: snapshot fence for agent charters and warden prompt (agent-prompt-regression gotcha)"
```

---

### Task 6: Scripted-failure model-provider scenario

E2E guarantee that a model-provider outage degrades cleanly: failed run in the ledger, no partial writes, vault still syncs. Uses `dome.warden.integrity` (garden, `document.changed` on `wiki/**`, `model.invoke`) with an injected always-failing provider.

**Files:**
- Create: `tests/harness/scenarios/effect-routing/model-provider-failure.scenario.test.ts`

- [ ] **Step 1: Check the scenario-options passthrough**

`tests/harness/types.ts:106` declares `modelProvider?: ModelProvider` on the harness options. Confirm the `scenario(...)` wrapper forwards it:
Run: `grep -n "modelProvider" tests/harness/index.ts tests/harness/harness.ts`
Expected: the scenario `harness:` block reaches `HarnessImpl` (harness.ts:121/128 stores it). If `index.ts`'s scenario-options type omits it, add the field to that options type and forward it — mirror exactly how `bundles` / `initialFiles` flow through.

- [ ] **Step 2: Write the scenario**

```ts
// scenarios/effect-routing/model-provider-failure.scenario.test.ts
//
// A model-provider outage must degrade cleanly: the garden run fails and is
// ledgered, no question/patch lands from the failed run, and the vault keeps
// adopting. Pins the e2e contract behind
// docs/wiki/specs/processor-execution.md §model failures.

import { expect } from "bun:test";

import { queryRuns } from "../../../../src/ledger/runs";
import { scenario } from "../../index";

scenario(
  {
    name: "effect-routing: model provider failure → failed run, stable vault",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "phase", phase: "garden" },
      { kind: "capability", capability: "model.invoke" },
      { kind: "trigger", trigger: "signal" },
    ],
    harness: {
      bundles: ["dome.warden"],
      modelProvider: async () => {
        throw new Error("simulated provider outage");
      },
      initialFiles: {
        ".dome/config.yaml": `
extensions:
  dome.warden:
    enabled: true
    grant:
      read: ["wiki/**/*.md"]
      model.invoke: true
      question.ask: true
`,
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: { "wiki/entities/acme.md": "# Acme\n\nA company we work with.\n" },
      message: "add acme page",
    });
    const tick = await h.tick();
    expect(tick.adopted).toBe(true);
    await h.drainOperationalWork();

    // The warden run is ledgered as failed (not silently absent, not succeeded).
    const wardenRuns = queryRuns(h.ledger, {
      processorId: "dome.warden.integrity",
    });
    expect(wardenRuns.length).toBeGreaterThan(0);
    expect(
      wardenRuns.every((run) => run.status !== "succeeded"),
    ).toBe(true);
    expect(wardenRuns.some((run) => run.status === "failed")).toBe(true);

    // No question landed from the failed model call.
    await h.expectProjection().questions().toHaveCount(0);

    // The vault keeps working: a follow-up commit still adopts cleanly.
    await h.userCommit({
      files: { "wiki/entities/beta.md": "# Beta\n\nAnother page.\n" },
      message: "add beta page",
    });
    const next = await h.tick();
    expect(next.adopted).toBe(true);
  },
);
```

Adaptation notes (each verifiable, none speculative):
- `userCommit` input shape: confirm with `grep -n "UserCommitInput" tests/harness/types.ts` and match its field names (`files`/`message` or as declared).
- `queryRuns` filter shape: confirm with `sed -n '691,708p' src/ledger/runs.ts`; if the filter key differs (e.g. `processor_id`), match it. If a harness `expectLedger({ processorId })` matcher covers this (types.ts:342-350), prefer it over importing `queryRuns`.
- Question-count matcher: the projection matcher exposes `questions()` (types.ts:371); if `toHaveCount` isn't available on it, assert via the existing `toContainQuestion` negation or `h.runCli(["inspect", "questions", "--json"])` returning `[]`.
- If garden retry machinery quarantines `dome.warden.integrity` after repeated retryable failures, the `failed`-status assertion still holds (quarantine happens on top of failed runs); do **not** assert on quarantine state — that's the retry policy's business.

- [ ] **Step 3: Run it**

Run: `bun test tests/harness/scenarios/effect-routing/model-provider-failure.scenario.test.ts`
Expected: PASS. If the coverage-matrix validator rejects a tag, align tag values with a neighboring scenario (`health-quarantine-recovery.scenario.test.ts` is the closest model).

- [ ] **Step 4: Run the full harness suite + commit**

Run: `bun test tests/harness`
Expected: PASS.

```bash
git add tests/harness/scenarios/effect-routing/model-provider-failure.scenario.test.ts tests/harness/index.ts tests/harness/harness.ts
git commit -m "test(harness): model-provider outage scenario — failed run ledgered, vault stays adoptable"
```

(Only include the two harness files if Step 1 required the passthrough edit.)

---

### Final gate

- [ ] **Run the full suite**

Run: `bun test`
Expected: PASS across the board.

- [ ] **Docs-vault hygiene**: the docs edits will be adopted by the dogfood vault's own loop on merge; no manual `dome` invocation needed from the worktree.

---

## Deferred (explicitly out of scope for this branch — tracked, do not drop)

These are review items 5–7, recorded as session tasks #1–#3 and in memory (`dome-2026-06-review-backlog`):

- **Item 5 (task #1):** processor stdlib extraction (shared markdown/fence/anchor/config helpers across bundles) + `daily-shared.ts` decomposition + `export-context.ts` staging.
- **Item 6 (task #2):** `markTerminal` unification (runtime/ledger/outbox) + `adopt.ts` `applyEffectsForProcessor` extraction + `parseEnum`/`queryAll`/branded-id hardening.
- **Item 7 (task #3):** `tests/cli/commands.test.ts` split + `withVault` adoption in CLI commands + status/check/doctor tier cleanup.
- **Banked design decision:** merge the three recovery effect kinds into one `OperationalRecoveryEffect` (taxonomy 11→9) — made mechanical by Task 3's shared contract; needs a spec change + grant migration if taken.
