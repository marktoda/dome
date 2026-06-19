# Architecture Review "Now" Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the six "Now" items from the 2026-06-19 Dome architecture review — pull the hosted agent inside the structural write-authorization discipline, reconcile docs to shipped reality, and convert three per-code-path invariants + one hand-rolled abort-chain into structural enforcers.

**Architecture:** Six file-disjoint changes. A new `WriteScope` chokepoint (`src/write-scope.ts`) gives the hosted agent path-scoped write authorization reusing the engine's `globMatch`. The garden cascade-cap moves to the single `spawnGardenSubProposal` conversion boundary. A lockstep test pins the two-call-site PatchEffect broker contract. The orphan-run suppression literal becomes a typed const + structured code. The `adopt.ts` finalization tail becomes a `finalizeAdoption` shell with one `abort()` helper. Plus doc reconciliation.

**Tech Stack:** TypeScript, Bun, `bun test ./tests`, isomorphic-git, the four-concept Dome engine.

## Global Constraints

- **Canonical gate is the runtime suite:** `bun test ./tests` (NOT bare `bun test` — that sweeps `pwa/` without happy-dom). Full-repo `tsc` is pre-existing red; do not use it as a gate. PWA suite (only if PWA touched): `cd pwa && bun test`.
- **House style (docs/philosophy.md):** pure-decide functions + thin I/O shells; numbered invariants with NAMED mechanical enforcers; structural > check-script > prose; reuse the ONE shared matcher (`globMatch` from `src/engine/core/glob-cache.ts`), never a parallel glob impl; locality > centralization; do NOT generalize at N=1.
- **Axiom floors that must never weaken:** `.dome/**` and RAW (`inbox/raw/**`) are unconditional no-write for the agent path (`RAW_IS_IMMUTABLE`, `MARKDOWN_IS_SOURCE_OF_TRUTH`). `PROPOSALS_ARE_THE_ONLY_WRITE_PATH` / `ENGINE_IS_THE_ONLY_APPLIER` are unaffected (the hosted agent still writes via git commit + adoption).
- **Mutation-fence:** any new file calling `writeFile`/`mkdir`/git-write must be added to `tests/integration/no-direct-mutation-outside-boundaries.test.ts` ALLOWED_FILES. `src/write-scope.ts` does pure glob matching (no fs/git) → no allow-list entry needed.
- **Commit trailer:** end commit messages with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Tasks are independent and file-disjoint; execute in order; each ends green.

## File structure

- `src/write-scope.ts` (NEW) — `WriteScope` type, `DEFAULT_AGENT_WRITE_SCOPE`, `writeScopeDenial(path, scope)`. Pure glob logic.
- `src/agent/write.ts` (MODIFY) — add RAW floor to `vaultRelPath`; apply `writeScopeDenial`; thread optional `scope` on `AgentWriteCtx`.
- `docs/wiki/concepts/client-model.md`, `docs/wiki/specs/mcp-surface.md`, `docs/wiki/specs/http-surface.md`, `docs/wiki/matrices/protocol-adapter.md`, `docs/wiki/specs/capabilities.md`, `docs/wiki/specs/adoption.md` (MODIFY) — reconcile to the shipped hosted agent.
- `src/http/server.ts` (MODIFY) — delete stale "local copy / mirrors src/http" comments; one error-envelope decision.
- `src/engine/garden/{garden.ts,garden-sub-proposals.ts,garden-patch-dispatch.ts,garden-run-routing.ts}` (MODIFY) — cascade-cap to the single chokepoint.
- `tests/integration/patch-effect-broker-lockstep.test.ts` (NEW) — assert every PatchEffect path enforces capability.
- `src/ledger/runs.ts`, `assets/extensions/dome.health/processors/orphan-run-recovery-answer.ts` (MODIFY) — typed const + structured orphan-recovery code.
- `src/engine/core/adopt.ts` (MODIFY) — extract `finalizeAdoption`.

---

### Task 1: WriteScope — path-scoped write authorization for the hosted agent

**Files:**
- Create: `src/write-scope.ts`
- Modify: `src/agent/write.ts`
- Test: `tests/agent/write-scope.test.ts` (new), extend `tests/agent/write.test.ts`

**Interfaces:**
- Consumes: `globMatch(pattern: string, path: string): boolean` from `src/engine/core/glob-cache.ts`.
- Produces:
  - `type WriteScope = { readonly allow: readonly string[]; readonly deny: readonly string[] }`
  - `const DEFAULT_AGENT_WRITE_SCOPE: WriteScope`
  - `function writeScopeDenial(relPath: string, scope: WriteScope): string | null` — denial reason or null if allowed.
  - `AgentWriteCtx` gains `readonly scope?: WriteScope` (optional; defaults to `DEFAULT_AGENT_WRITE_SCOPE`).

**Why (review §3.1):** The hosted agent is the only un-broker-scoped writer — `write.ts` gates only `.dome/`+`.md`+escape, so an LLM with no human in the loop can overwrite `index.md`/`log.md`/`inbox/raw`. This adds a path-scope layer reusing the engine's matcher, strictly tightening today's behavior, designed so the in-engine path can adopt the same chokepoint later (review §4.2, deferred).

- [ ] **Step 1: Write the failing test (`tests/agent/write-scope.test.ts`)**

```typescript
import { describe, expect, test } from "bun:test";
import { writeScopeDenial, DEFAULT_AGENT_WRITE_SCOPE } from "../../src/write-scope";

describe("writeScopeDenial (default agent scope)", () => {
  test("allows ordinary wiki + daily markdown", () => {
    for (const p of ["wiki/notes/foo.md", "wiki/entities/x.md", "daily/2026-06-19.md", "core.md"]) {
      expect(writeScopeDenial(p, DEFAULT_AGENT_WRITE_SCOPE)).toBeNull();
    }
  });
  test("denies generated/frozen registry files", () => {
    for (const p of ["index.md", "log.md"]) {
      expect(writeScopeDenial(p, DEFAULT_AGENT_WRITE_SCOPE)).not.toBeNull();
    }
  });
  test("denies RAW inbox", () => {
    expect(writeScopeDenial("inbox/raw/2026-06-19-1200-x.md", DEFAULT_AGENT_WRITE_SCOPE)).not.toBeNull();
  });
  test("a custom scope whose allow-list excludes a path denies it", () => {
    const scope = { allow: ["wiki/**"], deny: [] as string[] };
    expect(writeScopeDenial("daily/x.md", scope)).not.toBeNull();
    expect(writeScopeDenial("wiki/x.md", scope)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `bun test ./tests/agent/write-scope.test.ts` → "Cannot find module '../../src/write-scope'".

- [ ] **Step 3: Implement `src/write-scope.ts`**

```typescript
// src/write-scope.ts
//
// Path-scoped write authorization for agent write paths. A configurable layer
// ON TOP OF the unconditional structural floors (`.dome/`, RAW, .md-only) that
// src/agent/write.ts enforces directly. Reuses the engine's single `globMatch`
// matcher — no parallel glob language. Designed as the shared chokepoint both
// the hosted agent (src/agent/write.ts) and, later, the in-engine agents can
// consult (review §3.1 / §4.2).

import { globMatch } from "./engine/core/glob-cache";

export type WriteScope = {
  /** Glob patterns a path must match at least one of (empty = allow all). */
  readonly allow: readonly string[];
  /** Glob patterns that, if any matches, deny the write (wins over allow). */
  readonly deny: readonly string[];
};

/**
 * Default hosted-agent scope: any markdown EXCEPT the generated index and the
 * frozen activity log (NO_ACCRETING_REGISTRIES — writing them is always a bug).
 * `.dome/` and RAW are denied unconditionally upstream in write.ts, not here.
 */
export const DEFAULT_AGENT_WRITE_SCOPE: WriteScope = Object.freeze({
  allow: ["**/*.md"],
  deny: ["index.md", "log.md"],
});

/** Denial reason if `relPath` is out of `scope`, else null. Deny wins over allow. */
export function writeScopeDenial(relPath: string, scope: WriteScope): string | null {
  for (const pattern of scope.deny) {
    if (globMatch(pattern, relPath)) {
      return `path '${relPath}' is denied by write scope (matches deny '${pattern}')`;
    }
  }
  if (scope.allow.length > 0 && !scope.allow.some((p) => globMatch(p, relPath))) {
    return `path '${relPath}' is outside the write scope (no allow pattern matched)`;
  }
  return null;
}
```

- [ ] **Step 4: Wire it into `src/agent/write.ts`**

(a) Add the RAW floor to `vaultRelPath` (after the `.dome` check, before the `.md` check):

```typescript
  if (norm.split("/")[0] === ".dome") {
    throw new AgentWriteError(".dome/ is engine-internal and off-limits to the agent");
  }
  if (norm.startsWith("inbox/raw/")) {
    throw new AgentWriteError("inbox/raw/ is immutable (RAW_IS_IMMUTABLE); the agent cannot write raw capture files");
  }
  if (!norm.endsWith(".md")) {
```

(b) Add the import + thread the scope. Add to imports:

```typescript
import { DEFAULT_AGENT_WRITE_SCOPE, writeScopeDenial, type WriteScope } from "../write-scope";
```

(c) Extend `AgentWriteCtx`:

```typescript
export type AgentWriteCtx = { readonly vaultPath: string; readonly modelId: string; readonly scope?: WriteScope };
```

(d) Apply the scope inside `vaultRelPath`'s callers. Cleanest: make `vaultRelPath` take the scope and check it last. Change the signature to `function vaultRelPath(raw: string, scope: WriteScope): string` and add, right before `return norm;`:

```typescript
  const denial = writeScopeDenial(norm, scope);
  if (denial !== null) throw new AgentWriteError(denial);
  return norm;
```

Then update both call sites (`createDocument`, `editDocument`) from `vaultRelPath(input.path)` to `vaultRelPath(input.path, ctx.scope ?? DEFAULT_AGENT_WRITE_SCOPE)`.

- [ ] **Step 5: Extend `tests/agent/write.test.ts`** — add cases asserting `createDocument` rejects `index.md`, `log.md`, and `inbox/raw/x.md` with `AgentWriteError`, and still allows `wiki/new.md`:

```typescript
test("rejects generated/frozen/raw paths via the default write scope", async () => {
  const vault = await tempVault();
  for (const p of ["index.md", "log.md", "inbox/raw/x.md"]) {
    await expect(createDocument({ vaultPath: vault, modelId: "m" }, { path: p, content: "x\n" }))
      .rejects.toBeInstanceOf(AgentWriteError);
  }
});
```

- [ ] **Step 6: Run tests, expect PASS** — `bun test ./tests/agent/write-scope.test.ts ./tests/agent/write.test.ts ./tests/agent`

- [ ] **Step 7: Commit**

```bash
git add src/write-scope.ts src/agent/write.ts tests/agent/write-scope.test.ts tests/agent/write.test.ts
git commit -m "feat(agent): path-scoped write authorization (WriteScope) for the hosted agent

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Cascade-cap moves to the single conversion chokepoint

**Files:**
- Modify: `src/engine/garden/garden-sub-proposals.ts` (the chokepoint — add the cap), `src/engine/garden/garden.ts` (delete the inline pre-check at ~line 516), `src/engine/garden/garden-patch-dispatch.ts` + `garden-run-routing.ts` (ensure `cascadeDepth`/`maxCascadeDepth` thread through, no `?? 1` guess).
- Test: extend the garden cascade tests (grep `garden.cascade-cap` / `maxCascadeDepth` under `tests/`).

**Why (review §3.4):** The `cascadeDepth >= maxCascadeDepth` check lives ONLY in `garden.ts:516` (the signal path). The shared spawn path `dispatchGardenPatchEffect` (used by scheduler/jobs/answers via `routeGardenRunEffects`) has no cap and spawns with `cascadeDepth: opts.cascadeDepth ?? 1`. So operational garden sources have a weaker bound than signal ones — the cap is a property of one code path, not the cascade.

**Interfaces:**
- `spawnGardenSubProposal` (`garden-sub-proposals.ts:42`) currently takes `opts.cascadeDepth: number`. Add `opts.maxCascadeDepth: number` and have it return / signal a cap result when `cascadeDepth >= maxCascadeDepth` — emit the `garden.cascade-cap` diagnostic there (move it verbatim from `garden.ts`), skip the spawn, and surface the skip to the caller.

- [ ] **Step 1: Read the current cap block** in `garden.ts` (the `else if (cascadeDepth >= maxCascadeDepth)` arm and the `garden.cascade-cap` diagnostic it builds) and `spawnGardenSubProposal` end-to-end. Note exactly how `maxCascadeDepth` reaches `garden.ts` today (trace the caller) so the same value reaches `spawnGardenSubProposal`.

- [ ] **Step 2: Write a failing test** — add to the existing garden cascade test file a case driving an OPERATIONAL garden source (scheduler or jobs path via `routeGardenRunEffects`) at `cascadeDepth === maxCascadeDepth` and assert a `garden.cascade-cap` diagnostic is emitted and NO sub-Proposal spawns. (Today this passes through uncapped — the test should FAIL before the fix.) Run it, expect FAIL.

- [ ] **Step 3: Move the cap into `spawnGardenSubProposal`** — add `maxCascadeDepth` to its opts; at the top, if `opts.cascadeDepth >= opts.maxCascadeDepth`, build + record the `garden.cascade-cap` diagnostic (copied verbatim from `garden.ts`, including the skipped-count + named-processors message), and return a discriminated result (e.g. `{ kind: "cascade-capped"; diagnostic }`) without spawning. Make every caller (`garden.ts`, `garden-patch-dispatch.ts`) pass `maxCascadeDepth` explicitly — remove the `cascadeDepth ?? 1` guess in `garden-patch-dispatch.ts:115` by requiring the value from `routeGardenRunEffects` (thread it from the operational callers; default depth for a top-level operational run is the same value `garden.ts` uses for a top-level signal run — confirm that constant while reading).

- [ ] **Step 4: Delete the inline `else if (cascadeDepth >= maxCascadeDepth)` pre-check in `garden.ts`** — the chokepoint now owns it. `garden.ts` calls `spawnGardenSubProposal` and renders its cap result.

- [ ] **Step 5: Run tests, expect PASS** — `bun test ./tests` (garden cascade tests + full suite; this touches the engine core).

- [ ] **Step 6: Commit**

```bash
git add src/engine/garden/
git commit -m "refactor(garden): cascade-cap enforced at the single spawnGardenSubProposal chokepoint

Operational garden sources (scheduler/jobs/answers) were uncapped; the cap was a
property of the signal-path branch in garden.ts, not the cascade. Moves it to the
one conversion boundary all sources funnel through (review §3.4).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: PatchEffect broker lockstep test

**Files:**
- Create: `tests/integration/patch-effect-broker-lockstep.test.ts`

**Why (review §3.4):** PatchEffect — the only effect that mutates the canonical substrate — is broker-checked at TWO call sites: `apply-effect.ts:446` (adoption patches) and `garden-patch-router.ts:49` (garden patches). The `never`-exhaustive switch only fences the generic route; the garden route's broker call is a hand-maintained parallel. This converts the "two call sites stay in sync" prose contract into a mechanical enforcer.

**Interfaces:** Consumes the broker enforce function (grep `enforceCapability` in `src/engine/core/capability-broker.ts`) and the two patch routing modules.

- [ ] **Step 1: Decide the assertion shape.** Read `apply-effect.ts` around the adoption PatchEffect route (~line 446) and `garden-patch-router.ts` (~line 49). Pick the most robust mechanical check that doesn't ossify internals — preferred: a source-level assertion that both `apply-effect.ts` and `garden-patch-router.ts` reference `enforceCapability` (or the broker entry the other path uses), failing if either path stops calling the broker. (Mirror the style of `tests/integration/engine-import-direction.test.ts`, which parses files and asserts a structural property.) If a behavioral assertion is cheap (drive a PatchEffect through both paths with a deny grant and assert both are denied), prefer that — but do NOT spin up heavy fixtures; a source-parse lockstep is acceptable and is the house pattern for cross-file contracts.

- [ ] **Step 2: Write the test** at `tests/integration/patch-effect-broker-lockstep.test.ts` implementing the chosen assertion, with a comment citing review §3.4 and naming the invariant `PATCH_EFFECT_BROKER_CHECKED_ON_EVERY_PATH`.

- [ ] **Step 3: Run it, expect PASS** (both paths currently DO call the broker, so the test should pass green and stay as the guard) — `bun test ./tests/integration/patch-effect-broker-lockstep.test.ts`. Then sanity-check it FAILS if you temporarily comment out one broker call (revert immediately).

- [ ] **Step 4: Commit**

```bash
git add tests/integration/patch-effect-broker-lockstep.test.ts
git commit -m "test(engine): lockstep that every PatchEffect path enforces the broker

Pins the two broker call sites (adoption + garden patch routing) so neither can
drop capability enforcement silently (review §3.4).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Orphan-run suppression — typed const + structured code

**Files:**
- Modify: `src/ledger/runs.ts` (`LATEST_ACTIVE_PROBLEM_WHERE_SQL:466-472`, `FAIL_ORPHANS_SQL:498-501`, `isRecoveredOrphanRun:~849`), `assets/extensions/dome.health/processors/orphan-run-recovery-answer.ts:54`.
- Test: extend the runs-ledger / orphan-recovery tests (grep `isRecoveredOrphanRun` / `LATEST_ACTIVE_PROBLEM` under `tests/`).

**Why (review §3.4, findings D2+D5):** The `dome status` orphan-suppression filter matches a prose string twice — `error LIKE 'orphaned-run:%'` and `error = 'dome.health: mark orphaned processor run failed'` — the latter duplicated verbatim in the health processor (`orphan-run-recovery-answer.ts:54`). A rename silently breaks suppression and loops the health machinery. This (1) extracts the health reason as a typed const imported at both sites, and (2) adds a structured recovery marker so the filter matches a code, not a paraphrase. Name the invariant `ORPHAN_RECOVERED_RUNS_ARE_SUPPRESSED`. Keep the `LIKE 'orphaned-run:%'` arm as a backward-compat fallback for already-written rows.

- [ ] **Step 1: Write/extend the failing test** — assert that a run failed via the health orphan-recovery path is suppressed from `latestActiveProblemRuns`/the count, and that the suppression keys on the structured marker (not only the prose string). Drive it through the real ledger helpers. Run, expect FAIL (the structured marker doesn't exist yet).

- [ ] **Step 2: Export the reason const from `runs.ts`** (or a shared constants location adjacent to it):

```typescript
/** The exact failure reason the dome.health orphan-recovery answer writes; imported by the processor so the suppression filter and the writer never drift. */
export const ORPHAN_RUN_RECOVERY_ERROR_REASON = "dome.health: mark orphaned processor run failed";
```

Import it in `orphan-run-recovery-answer.ts:54` and use it for the `reason` field (replacing the literal).

- [ ] **Step 3: Add the structured code** — have both recovery write paths (`FAIL_ORPHANS_SQL` and the health answer's `RunRecoveryEffect`) include a structured `code: "processor.orphan-recovered"` in the persisted error JSON. Extend `LATEST_ACTIVE_PROBLEM_WHERE_SQL` to also suppress `json_extract(error, '$.code') = 'processor.orphan-recovered'`, keeping the two existing `LIKE`/`=` arms as backward-compat fallbacks. Update `isRecoveredOrphanRun` to check the code first, then fall back to the string prefix. (Read the exact `error`-column write shape first — confirm whether it's JSON or plain text today, and only add `json_extract` if the column holds JSON; if it's plain text, gate the structured-code arm behind the column actually being JSON and document the migration in a comment.)

- [ ] **Step 4: Run tests, expect PASS** — `bun test ./tests` (ledger + orphan-recovery + health).

- [ ] **Step 5: Commit**

```bash
git add src/ledger/runs.ts assets/extensions/dome.health/processors/orphan-run-recovery-answer.ts tests/
git commit -m "refactor(ledger): structured orphan-recovery marker + typed reason const

Replaces the prose-string coupling between the dome.health recovery reason and the
dome-status suppression filter with a typed const + a structured code; keeps the
LIKE fallback for already-written rows (review §3.4, ORPHAN_RECOVERED_RUNS_ARE_SUPPRESSED).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Extract `finalizeAdoption` from `adopt.ts`'s abort-chain tail

**Files:**
- Modify: `src/engine/core/adopt.ts` (the finalization tail, ~lines 604-921).
- Test: the existing finalize-journal + adoption e2e tests must stay green (grep `finalize` / `finalizeJournal` under `tests/`).

**Why (review §3.4 / A2):** `adopt()`'s finalization tail is a ~220-line linear chain where 5+ steps repeat the identical shape: attempt; on failure push a `diagnosticEffect`, call `recordDiagnosticsViaSink`, and `return frozenResult({ adopted: false, ... })`. This is crash-safety-critical code where a structural lego-block (one `abort()` helper) removes the duplicated abort dance and separates the converged-pipeline from the ref/tree-mutation I/O shell — matching the file's own "pure-decide + thin I/O shell" banner.

**Interfaces:** Internal-only refactor; `adopt()`'s public signature and return type are UNCHANGED. Behavior must be byte-identical (same diagnostics, same journal-clear ordering, same `frozenResult` on every path).

- [ ] **Step 1: Read the entire finalization tail** (closure-commit decision → ledger back-fill → branch fast-forward check → materialize-validate → write-finalize-journal → writeRef → materialize → setAdoptedRef → clear-journal → flush) and enumerate every abort branch (push diagnostic → record → return frozenResult). This is a NO-BEHAVIOR-CHANGE refactor — list the exact diagnostics + ordering so they're preserved verbatim.

- [ ] **Step 2: Confirm the baseline is green** — `bun test ./tests` (note the finalize-journal + adoption e2e test names; these are the guard). Do NOT proceed if any are red.

- [ ] **Step 3: Extract `finalizeAdoption(...)`** — a function returning a discriminated `FinalizeOutcome = { kind: "finalized"; newAdopted: ... } | { kind: "blocked"; diagnostics: ... }`, with ONE internal `abort(diag): FinalizeOutcome` helper that does the push + `recordDiagnosticsViaSink` + journal-clear once. `adopt()` then ends: run loop → `finalizeAdoption(...)` → map the outcome to `frozenResult`. Preserve every diagnostic code/message and the exact journal-clear ordering. Keep `finalizeAdoption` in `adopt.ts` (adoption's own finalizer — locality, not a generalized util).

- [ ] **Step 4: Run the full suite, expect PASS with NO diffs in behavior** — `bun test ./tests`. The finalize-journal + adoption e2e tests must be green and unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/engine/core/adopt.ts
git commit -m "refactor(engine): extract finalizeAdoption with one abort() helper

Collapses adopt()'s ~220-line finalization tail (5+ duplicated push-diagnostic /
record / return-frozenResult blocks) into one shell + one abort() helper, separating
the converged pipeline from the ref/tree-mutation I/O shell. No behavior change
(review §3.4 / A2).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Reconcile docs to the shipped hosted agent + tidy convergence fossils

**Files:**
- Modify: `docs/wiki/concepts/client-model.md`, `docs/wiki/specs/mcp-surface.md`, `docs/wiki/specs/http-surface.md`, `docs/wiki/matrices/protocol-adapter.md`, `docs/wiki/specs/capabilities.md`, `docs/wiki/specs/adoption.md`, `src/http/server.ts`.

**Why (review §1.6 / §2):** Shipped code now contradicts the docs. `client-model.md:148-150` and `mcp-surface.md:103` say "HTTP hosts no model / read+capture surface," but `dome http` ships an LLM agent (`/agent`, own charter, `DEFAULT_MODEL`, tool loop). The protocol-adapter matrix has no `/agent`/`/transcribe`/`/recents`/`/today`/`author` rows. `adoption.md:35`'s pseudocode shows `candidate := merge(adopted, P.head)` the code never does (`adopt.ts:313`). `server.ts` carries stale "local copy / do NOT import from src/http" + "mirrors src/http/server.ts" comments (lines ~142, 163, 237, 717) that are fossils from the two-server era — this file IS `src/http/server.ts` now — and two error-envelope shapes (`errorResponse` with `schema` vs `dataErrorResponse` without).

- [ ] **Step 1: Reconcile the client-model + surface docs.** In `client-model.md` and `mcp-surface.md`, update the "hosts no model / read+capture" framing to admit the shipped hosted agent: HTTP `dome http` now optionally hosts a write-capable agent (`/agent`, `--allow-write`), while the *contract-is-the-product* principle still holds (the agent is a co-located client, not a hosted multi-tenant service). State that the two capability vocabularies are ORTHOGONAL layers, not redundant: the `read·capture·resolve·converse·author` set scopes *who can reach a route*; the engine's broker tiers scope *what an effect may do* — they compose. Add one sentence to `capabilities.md` saying exactly that. Match each page's voice/length; retire stale sentences in place (don't append).

- [ ] **Step 2: Add the missing rows to `protocol-adapter.md`** — `POST /agent` (+`/agent/stream`), `POST /transcribe`, `GET /recents`, `GET /today`, and the `author` capability, mapped to the AbstractSurface operations / capability column the matrix uses. Use honest schema/capability values (grep `src/http/server.ts` if unsure).

- [ ] **Step 3: Fix the `adoption.md` merge pseudocode** — change `candidate := merge(adopted, P.head)` to `candidate := P.head  # proposal-construction guarantees head descends from adopted` and add a one-line pointer that real 3-way merging happens in the garden-patch path (`apply-patch.ts merge3`), not in `adopt()`.

- [ ] **Step 4: Tidy `src/http/server.ts` fossils** — delete the stale "Local copy; do NOT import from src/http" and "mirrors src/http/server.ts (EXACTLY)" comments (this file is that server now). Resolve the two error envelopes: either collapse `errorResponse`/`dataErrorResponse` to one shape, OR keep the `/agent` `schema: "dome.ask/v1"` divergence as the single documented exception (the `SCHEMA` const comment already explains the wire-id freeze) and make every other route use the schema-less data envelope. Do NOT change wire behavior the PWA depends on — `/agent` keeps `dome.ask/v1`. This is comment cleanup + at most a one-helper consolidation; if collapsing the envelopes risks a wire change, leave them and just delete the misleading comments + add a one-line note why two exist.

- [ ] **Step 5: Verify** — `grep -rn "hosts no model\|read+capture surface\|Local copy\|mirrors src/http" docs src/http/server.ts` returns nothing stale; `bun test ./tests/http` green (if server.ts touched). Re-read each edited section once for voice/accuracy and verify any `[[wikilinks]]` resolve.

- [ ] **Step 6: Commit**

```bash
git add docs/ src/http/server.ts
git commit -m "docs: reconcile client-model/surfaces to the shipped hosted agent; tidy server fossils

Admits the dome http hosted write agent (client-model, mcp-surface, protocol-adapter
matrix, capabilities); names the two capability vocabularies as orthogonal layers;
fixes the adoption.md merge pseudocode; deletes the two-server-era 'mirrors src/http'
comments (review §1.6/§2).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (review §7 "Now"):** WriteGate → Task 1 ✓. Docs reconciliation (client-model/mcp-surface/protocol-adapter/adoption pseudocode/server fossils/error envelope) → Task 6 ✓. cascade-cap → Task 2 ✓. PatchEffect broker lockstep → Task 3 ✓. orphan-suppression structured code → Task 4 ✓. adopt.ts finalizeAdoption → Task 5 ✓.

**Placeholder scan:** Tasks 2, 4, 5 intentionally instruct the implementer to READ current code before transforming (cascade-cap move, orphan error-column shape, the 220-line adopt tail) rather than pasting reconstructed bodies — these are refactors of existing code where the live file is ground truth, with exact targets + behavior-preservation requirements + test gates given. Tasks 1 and the new const (4) carry complete code. This is the correct granularity for refactor-of-existing vs. greenfield.

**Type consistency:** `WriteScope`/`writeScopeDenial`/`DEFAULT_AGENT_WRITE_SCOPE` are defined once (Task 1) and consumed only there + write.ts. `ORPHAN_RUN_RECOVERY_ERROR_REASON` defined in runs.ts (Task 4), imported in the health processor. `finalizeAdoption`/`FinalizeOutcome`/`abort` are internal to adopt.ts (Task 5). No cross-task signature drift.

**Risk ranking (for execution gating):** Task 2 (cascade-cap, engine core) and Task 5 (adopt.ts, crash-safety) are highest-risk → per-task review. Task 1 (WriteGate, security boundary) → per-task review. Tasks 3, 4, 6 → tests-green + diff check, swept by the thorough final review.
