# Cleanup Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the `typecheck`/`v1:check` gate to green, finish the EvalHarness slice cleanly, delete dead `owns.region` machinery, and collapse the recovery-effect family **iff** it genuinely nets simpler.

**Architecture:** Four ordered tasks. Structural/eval changes land first; the `typecheck → 0` sweep runs LAST so it catches any fallout. The recovery-family collapse is recon-gated (two reviewers disagreed on whether it simplifies given divergent generation fields) — execute only if it nets simpler, else STOP and report.

**Tech Stack:** TypeScript, Bun, `bun test ./tests`, `bun run typecheck` (tsgo), `bun run eval`.

## Global Constraints

- **Two gates this batch must leave green:** `bun test ./tests` (runtime) AND `bun run typecheck` (currently 26 errors → 0 is Task 4's deliverable; `v1:check` runs typecheck first, so this restores the full gate). NOT bare `bun test` (sweeps pwa/).
- **No suppression:** fix type errors by correcting types, NOT `as any` / `@ts-expect-error` / `@ts-ignore`. If a tsc error reveals a real bug, STOP and report it.
- **House style (docs/philosophy.md):** pure-decide + thin shells; named invariants with mechanical enforcers; do NOT generalize at N=1; locality > centralization. Effect-kind / capability-tier changes must keep their lockstep enforcers (DB CHECK ↔ TS union, the `never`-exhaustive routers, `check:*` fences) in sync.
- **`owns.path` is OUT of scope** — it is wired into `src/engine/core/path-capabilities.ts` (unlike `owns.region`, which only throws), so its removal needs a separate careful pass. Touch only `owns.region` here.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## Verified recon

- `owns.region` is unbuilt and THROWS at three sites: `src/extensions/manifest-schema.ts:385`, `src/engine/core/capability-policy.ts:787`, `src/engine/core/capability-broker.ts:297`. Referenced in docs: glossary, v1.md, capabilities.md, effect-x-capability matrix, extension-bundle-shape matrix, vault-layout, capability-downgrade-surprise, processor-fixed-point-divergence. It is superseded by the generated-block primitive + path-scoped `patch.auto`.
- Recovery family: 3 effect kinds `OutboxRecoveryEffect`/`QuarantineRecoveryEffect`/`RunRecoveryEffect` (`src/core/effect.ts:317/331/350`, schemas at 654/665/681) — **divergent generation fields**; 6 tiers (`capability-policy.ts:391-396`); routed in `apply-effect.ts` + `capability-broker.ts`; emitted only by `assets/extensions/dome.health/processors/orphan-run-recovery-{questions,answer}.ts`. Also referenced in `src/index.ts`, `runs.ts`, `dispatch.ts`, `processor.ts`, `sinks.ts`.
- 26 tsc errors: 24 in tests (biggest `tests/http/server-agent-routes.test.ts` 13; `tests/engine/model-step-provider-override.test.ts` 3), 2 in src (`src/eval/provider.ts` live-path, `src/cli/commands/today.ts`).

## File structure (per task)

- Task 1 (eval fast-follows): NEW `src/eval/cases/brief-fixtures.ts`; MODIFY `src/eval/cases/brief.ts`, `scripts/eval.ts`, `tests/eval/brief-case.test.ts`, `src/eval/provider.ts`; the fixture VAULT files stay under `tests/fixtures/eval/brief-basic/vault/`.
- Task 2 (delete owns.region): MODIFY the 3 throw sites + the tier/union definitions + the doc references.
- Task 3 (recovery collapse, gated): `src/core/effect.ts`, `capability-policy.ts`, `capability-broker.ts`, `apply-effect.ts`, `sinks.ts`, the dome.health processors + the effect-router/capability matrices + DB-CHECK lockstep — OR a recon report if deferred.
- Task 4 (typecheck → 0): wherever the remaining errors are.

Tasks 2 & 3 are RISKY (capability/effect surface) → per-task review. Tasks 1 & 4 → tests-green + diff check.

---

### Task 1: Eval fast-follows — kill the `src→tests` import, add charter canary, fix live-path tsc

**Files:**
- Create: `src/eval/cases/brief-fixtures.ts`
- Modify: `src/eval/cases/brief.ts`, `scripts/eval.ts`, `tests/eval/brief-case.test.ts`, `src/eval/provider.ts`
- (Leave the fixture vault data under `tests/fixtures/eval/brief-basic/vault/`.)

**Why:** `src/eval/cases/brief.ts` + `scripts/eval.ts` import `FIRED_AT`/`TODAY_DAILY_PATH`/`BRIEF_BASIC_SCRIPT` from `tests/fixtures/eval/brief-basic/script.ts` — an inverted `src→tests` dependency (harmless today since `src/eval` isn't in the public graph, but a smell). Move the SHARED CONSTANTS + the scripted script `src`-side; keep the vault data file-tree under tests/fixtures. Also harden the brief-gate (charter canary) and clear the 2 `src/eval/provider.ts` tsc errors.

- [ ] **Step 1: Read** `tests/fixtures/eval/brief-basic/script.ts` (what it exports: `FIRED_AT`, `TODAY_DAILY_PATH`, `BRIEF_BASIC_SCRIPT`, and the vault-dir path const if any), `src/eval/cases/brief.ts` (how it loads the fixture vault dir + uses the constants), `scripts/eval.ts` (its import), and `src/eval/provider.ts` lines ~140-180 (the `as never` + the `messages: ModelMessage[]` mapping in `liveEvalEnv`).

- [ ] **Step 2: Create `src/eval/cases/brief-fixtures.ts`** — move `FIRED_AT`, `TODAY_DAILY_PATH`, `BRIEF_BASIC_SCRIPT` here (and a `BRIEF_FIXTURE_VAULT_DIR` const pointing at the `tests/fixtures/eval/brief-basic/vault/` path via a path resolved relative to the repo, NOT an import of test code — a string path is data, not a code import). Re-export nothing from tests/. Update `tests/fixtures/eval/brief-basic/script.ts` to either be deleted (if everything moved) or to re-export from the new src location for any test that used it — preferring deletion if no other consumer.

- [ ] **Step 3: Update importers** — `src/eval/cases/brief.ts` and `scripts/eval.ts` import the constants from `./brief-fixtures` (no `../../../tests/...`). `tests/eval/brief-case.test.ts` imports from the src location too. Confirm `grep -rn "tests/fixtures/eval" src scripts` returns NO src/scripts hits (only the vault data path string, which is allowed).

- [ ] **Step 4: Add the charter canary** — in `tests/eval/brief-case.test.ts` (or a small dedicated test), assert that the brief charter (`assets/extensions/dome.agent/.../brief-charter.ts`) STILL begins with the exact marker string the brief-gate keys on (read the gate in `src/eval/cases/brief.ts` to get the literal). So a charter reword fails THIS test with a clear "charter marker drifted" message rather than a cryptic downstream shape failure.

- [ ] **Step 5: Fix the 2 `src/eval/provider.ts` tsc errors** — type the `liveEvalEnv` `tools` and `messages` mappings properly (no `as never`; map to the real `ModelMessage[]` / `ToolSet` shapes the AI SDK expects). Run `bunx tsc --noEmit src/eval/provider.ts` style check or `bun run typecheck 2>&1 | grep src/eval/provider` → 0.

- [ ] **Step 6: Verify** — `bun test ./tests/eval` green; `bun run eval` exits 0; `grep -rn "tests/fixtures/eval" src scripts` clean of code imports. Run `bun test ./tests` once.

- [ ] **Step 7: Commit** `git add src/eval scripts/eval.ts tests/eval tests/fixtures/eval && git commit -m "refactor(eval): src-side fixture constants + charter canary + provider tsc fixes\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 2: Delete `owns.region` (dead, throws-at-load)

**Files:**
- Modify: `src/extensions/manifest-schema.ts:385`, `src/engine/core/capability-policy.ts:787` (+ the tier-list entry if `owns.region` is in the tier union), `src/engine/core/capability-broker.ts:297`; the doc references (glossary, capabilities.md, the effect-x-capability + extension-bundle-shape matrices, vault-layout, the two gotchas). Check `src/core/processor.ts` + `manifest-schema.ts` for the tier-union/enum membership.

**Why:** `owns.region` is unbuilt, throws at all three reachable sites, has zero shipped users, and is superseded by the generated-block primitive + path-scoped `patch.auto`. It is a "hope" tier — vocabulary with no referent. Both architecture-review subagents agreed it's a clean delete. (`owns.path` stays — it's wired into `path-capabilities.ts`; separate pass.)

- [ ] **Step 1: Map every `owns.region` reference** — `grep -rn "owns.region\|owns\.region\|ownsRegion\|OwnsRegion" src assets docs`. Determine whether `owns.region` is a member of a capability-tier UNION/enum (so removing it is a type change) or only string literals in throw messages. Read the three throw sites + any tier-union definition.

- [ ] **Step 2: Write/adjust the failing test** — if there's a test asserting `owns.region` throws (grep `owns.region` under `tests/`), it must be removed/updated (the capability no longer exists). If a capability-tier-count or DB-CHECK↔union lockstep test pins the tier set, it will fail after removal — that's expected; update it to the new set. Run the relevant tests first to see what references the tier.

- [ ] **Step 3: Remove `owns.region`** — from the tier union/enum (if present), the three throw sites (delete the now-dead `case`/branch, not just the message), and any schema/manifest validation that enumerates it. Keep `owns.path` and all other tiers intact. Ensure the capability-broker's PatchEffect handling no longer references `owns.region`.

- [ ] **Step 4: Sweep the docs** — remove/retire `owns.region` mentions in glossary.md, capabilities.md, the effect-x-capability + extension-bundle-shape matrices, vault-layout.md, and the two gotchas (capability-downgrade-surprise, processor-fixed-point-divergence). Update any "seventeen tiers" count to the new number. Check the `no-retired-symbol-names` linter (`docs/wiki/linters/`) — if it has a retired-names list, `owns.region` may need adding (or the linter is doc-only; follow its convention).

- [ ] **Step 5: Verify** — `bun run typecheck 2>&1 | grep -i "owns.region"` empty; `bun test ./tests` green (capability/broker/tier lockstep tests pass with the reduced set); `grep -rn "owns.region\|owns\.region" src assets` returns nothing (docs may retain a historical mention in archive/ — leave dated archive files).

- [ ] **Step 6: Commit** `git add -A && git commit -m "refactor(capabilities): delete dead owns.region tier (unbuilt, threw at load)\n\nSuperseded by the generated-block primitive + path-scoped patch.auto; zero shipped\nusers. owns.path retained (wired into path-capabilities; separate pass).\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 3: Recovery-family collapse — RECON-AND-DECIDE gate

**Files (if executed):** `src/core/effect.ts` (the 3 kinds + schemas), `capability-policy.ts` (6 tiers), `capability-broker.ts` + `apply-effect.ts` (routing), `sinks.ts`, `src/index.ts`, the dome.health processors, the effect-router + effect-x-capability matrices, the DB-CHECK↔union lockstep.

**Why + the gate:** The architecture review proposed collapsing `Outbox/Quarantine/RunRecoveryEffect` → one `OperationalRecoveryEffect { target: "outbox"|"quarantine"|"run"; ... }` and 6 tiers → one `operational.recover { targets }`. BUT two review subagents disagreed: the concept reviewer rated it confidence-high / risk-low; the engine-spine reviewer rated it confidence-medium / "may NOT net simpler" because the three kinds have **divergent generation-identity fields** (run: `runId`/`startedAt`; quarantine: ~6 fields; outbox: `idempotencyKey`), so a union'd shape needs a per-target discriminated `generation`, partly re-introducing the branching the collapse aims to remove. **This task is gated on resolving that empirically.**

- [ ] **Step 1: RECON — read the three effect kinds' exact shapes** at `src/core/effect.ts:317-360` + their Zod schemas at 654-700, and the routing arms in `apply-effect.ts` + the sink methods (`recoverOutbox`/`recoverQuarantine`/`recoverRun`) + the 6 tiers. Tabulate the per-target fields. Read the 2 dome.health processors to see how they construct each effect.

- [ ] **Step 2: DECIDE (write the decision into the task report).** Collapse nets genuinely simpler IFF: the union'd `OperationalRecoveryEffect` + one sink + one routing arm + one tier-family removes more branching than the per-target discriminated `generation` re-introduces, AND the dome.health processors get simpler or no worse. 
  - **If YES → execute the collapse** (Steps 3-6): one `OperationalRecoveryEffect { target; action; generation: <discriminated-by-target>; reason; sourceRefs }`; one `operational.recover` tier (keep per-target grant granularity via `{ targets: [...] }` so no authority widening); one routing arm + one sink `recoverOperational(input)` dispatching on target; update the 3 dome.health emitters; update the effect-router + effect-x-capability matrices + the DB-CHECK↔TS-union lockstep + the `never`-exhaustive router; keep `EVERY_EFFECT_IS_CAPABILITY_CHECKED`. TDD: the existing recovery e2e/unit tests must pass against the collapsed shape (update them to the new effect/tier names; do NOT weaken assertions).
  - **If NO (the divergent generation fields make it a wash or worse) → STOP. Do NOT collapse.** Write the recon table + the reasoning into the report and report status DONE-NO-OP (the gate correctly declined). Do NOT force a collapse that re-introduces branching — that contradicts the owner's "fewer special-cases" goal.

- [ ] **Step 3-6 (only if DECIDE=YES):** implement the collapse per above; run `bun test ./tests` (all recovery + broker + projection-policy tests green); run `bun run typecheck` (union exhaustiveness); commit `refactor(effects): collapse recovery family into OperationalRecoveryEffect`. **If DECIDE=NO:** no commit; the report IS the deliverable.

- [ ] **Step 7: Report** the decision (YES/NO) with the recon table either way.

---

### Task 4: Restore `typecheck` → 0 (the gate)

**Files:** wherever errors remain after Tasks 1-3 (run `bun run typecheck` fresh — Task 1 cleared the 2 `src/eval` errors; Tasks 2-3 may have changed the count up or down).

**Why:** `bun run typecheck` has 26 errors → `v1:check` (which runs typecheck first) cannot pass, so the project's full gate is unusable and every change has been gated on `bun test ./tests` alone. Getting typecheck to 0 restores the gate.

- [ ] **Step 1: Enumerate** — `bun run typecheck 2>&1 | grep "error TS"` → the current list (after Tasks 1-3). Group by file. The biggest pre-existing cluster is `tests/http/server-agent-routes.test.ts` (13 — mock/`changes` typing from Phase 2); plus `tests/engine/model-step-provider-override.test.ts` (3, from the eval Task-1), `tests/extensions/dome.daily/*`, `dome.claims-render-stamp-convergence`, `dome.agent/ingest`, `cli/commands/today.test.ts`, and `src/cli/commands/today.ts` (1).

- [ ] **Step 2: Fix each, properly** — correct the types (mock shapes, missing fields, `string|null` narrowing, unused locals). NO `as any`/`@ts-ignore`/`@ts-expect-error` suppression. For each file, after fixing, the test it contains must still PASS (`bun test <file>`) — a type fix that breaks a test means the fix was wrong (or the test was). If any error exposes a real runtime bug (not just test-type sloppiness), STOP and report it rather than paper over it.

- [ ] **Step 3: Verify the gate** — `bun run typecheck` exits 0 (all three tsconfig projects: the script runs `tsc --noEmit && tsc -p tsconfig.bundles.json && tsc -p tsconfig.scripts.json`). Then `bun test ./tests` green. Optionally `bun run v1:check` now passes its typecheck step.

- [ ] **Step 4: Commit** `git add -A && git commit -m "fix(types): restore typecheck to 0 — v1:check gate usable again\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

## Self-Review

**Spec coverage (the approved "do it" scope):** Tier 1 (typecheck→0) → Task 4 ✓. Tier 2 (eval fast-follows) → Task 1 ✓. Tier 3 (recovery collapse) → Task 3, recon-gated (honest about the reviewer disagreement) ✓; `owns.region` delete → Task 2 ✓ (clean win); `owns.path` explicitly deferred (wired into path-capabilities — Global Constraints) ✓.

**Placeholder scan:** Tasks 2, 3, 4 are inherently read-then-transform across many files (owns.region refs; recovery shapes; tsc errors) — they specify exact recon targets + decision gates + "no suppression / report real bugs" rather than pre-fabricated code, the right granularity for wide-ripple cleanup. Task 1 carries concrete file moves. Task 3 explicitly may be a NO-OP (the gate) — that's a valid, intended outcome, not a placeholder.

**Type/name consistency:** `OperationalRecoveryEffect` / `operational.recover` names used consistently in Task 3 (only if executed). `brief-fixtures.ts` constants (`FIRED_AT`/`TODAY_DAILY_PATH`/`BRIEF_BASIC_SCRIPT`) consistent across Task 1's importers.

**Ordering:** structural/eval changes (1-3) before the `typecheck→0` sweep (4) so the sweep catches all fallout — correct.
