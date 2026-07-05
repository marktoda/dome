# Effect-Hashes Cap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap stored effect hashes at 100 per run with a count-bearing sentinel (497MB → ~25MB steady state), keep `dome inspect patches` counts honest, and correct the `EVERY_EFFECT_IS_LEDGERED` invariant's false mechanism claims.

**Architecture:** One capped collection site (`executor.ts`, where `effects.map(hashEffect)` is built — every consumer inherits). The sentinel is a codec-valid string element (`z.array(z.string().min(1))` passes); no DDL, no migration. Inspect parses the sentinel back to a true total. Docs corrected per the owned-prose rule.

**Tech Stack:** TypeScript on Bun; `bun test`.

## Global Constraints

- `EFFECT_HASHES_MAX = 100`. ≤100 effects → byte-identical list, no sentinel. >100 → first 100 hashes + ONE final sentinel element exactly `` `…+${dropped} more effect hashes` `` with the true dropped count.
- The result's `effects` array is untouched — only `effectHashes` is capped.
- No schema/DDL/codec-shape change; both codecs (`runs.ts` `EffectHashesSchema`, `capability-uses.ts`) stay `z.array(z.string().min(1))`.
- Inspect's `effect_hashes` column shows the TRUE emitted total for capped rows (100 + dropped), `length` otherwise; malformed sentinel → fall back to `length`.
- Invariant doc keeps its statement (every emission traceable); only the false mechanism prose (`ledger.recordEffect()`, per-hash join) is corrected.
- Typecheck gate: `bun run tsc --noEmit 2>&1 | grep -v "open-store.test.ts"` → zero new errors.

---

### Task 1: cap at the executor + honest inspect count

**Files:**
- Modify: `src/processors/executor.ts` (the `effectHashes = effects.map(hashEffect)` site, ~line 420-422; add the constant + cap beside `hashEffect` ~line 235)
- Modify: `src/cli/commands/inspect.ts` (~line 687 `effect_hashes: patch.effectHashes.length`)
- Test: `tests/processors/executor.test.ts`, `tests/processors/runtime-ledger.test.ts`, `tests/cli/commands/inspect.test.ts`

**Interfaces:**
- Produces: `EFFECT_HASHES_MAX = 100` and `EFFECT_HASHES_TRUNCATION_RE` (or a helper `effectHashCount(hashes: ReadonlyArray<string>): number`) — export the helper from wherever inspect can cleanly import it (prefer a small export from `src/processors/executor.ts` beside `hashEffect`, since it owns the sentinel format; inspect imports it).

- [ ] **Step 1: Write the failing tests**

`tests/processors/executor.test.ts` (mirror its existing execute-and-assert style, ~line 90 asserts one 64-hex hash):

```typescript
test("caps effect hashes at 100 with a count-bearing sentinel", async () => {
  // processor returning 120 effects (mirror the file's fixture style — e.g. 120 diagnosticEffects)
  expect(result.effectHashes.length).toBe(101);
  for (const h of result.effectHashes.slice(0, 100)) expect(h).toMatch(/^[0-9a-f]{64}$/);
  expect(result.effectHashes[100]).toBe("…+20 more effect hashes");
  expect(result.effects.length).toBe(120); // effects themselves untouched
});

test("exactly 100 effects is the boundary: all hashes stored, no sentinel", async () => {
  expect(result.effectHashes.length).toBe(100);
  expect(result.effectHashes.every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(true);
});
```

`tests/processors/runtime-ledger.test.ts` (dispatch-level round-trip, mirroring the matchedSignals-cap tests added yesterday): a fixture processor emitting >100 effects → persisted row's `effectHashes` decodes as 101 entries with the sentinel last; `queryPatchRecords`' JOIN codec also decodes it (one capability-use on the run).

`tests/cli/commands/inspect.test.ts` (~line 318 asserts `effect_hashes: 1`): add a fixture row whose `effect_hashes_json` is 100 hashes + `"…+724 more effect hashes"` → the patches row shows `effect_hashes: 824`. Plus unit tests for the helper: no sentinel → length; sentinel → 100+N; malformed sentinel-ish last element (e.g. `"…+x more effect hashes"`) → length.

- [ ] **Step 2: RED** — run the three files; new tests fail.

- [ ] **Step 3: Implement**

In `executor.ts`, beside `hashEffect`:

```typescript
/** Cap on stored per-effect hashes per run. Mass re-emission processors
 * (graph.links, search.index-text) emit hundreds of effects per run whose
 * hashes differ every run anyway (each effect embeds its sourceRef commit),
 * so past this cap the list records a count sentinel instead — 87% of the
 * column's bytes lived in 2% of rows. Nothing verifies these hashes; the
 * content record for every effect lives in its typed sink keyed by runId.
 * Mirrors MATCHED_SIGNALS_MAX (src/processors/runtime.ts). */
export const EFFECT_HASHES_MAX = 100;

const EFFECT_HASHES_SENTINEL_RE = /^…\+(\d+) more effect hashes$/;

/** True emitted-effect count for a stored hash list: parses the trailing
 * truncation sentinel when present, else the plain length. Exported for the
 * inspect surface. */
export function effectHashCount(hashes: ReadonlyArray<string>): number {
  const last = hashes[hashes.length - 1];
  const m = last === undefined ? null : EFFECT_HASHES_SENTINEL_RE.exec(last);
  if (m === null) return hashes.length;
  return hashes.length - 1 + Number(m[1]);
}
```

At the collection site, after the existing try/catch computes `effectHashes`:

```typescript
  if (effectHashes.length > EFFECT_HASHES_MAX) {
    const dropped = effectHashes.length - EFFECT_HASHES_MAX;
    effectHashes = [
      ...effectHashes.slice(0, EFFECT_HASHES_MAX),
      `…+${dropped} more effect hashes`,
    ];
  }
```

In `inspect.ts`: import `effectHashCount` and change the column to `effect_hashes: effectHashCount(patch.effectHashes)`.

- [ ] **Step 4: GREEN + guardrails** — the three files pass; also `bun test tests/ledger/runs.test.ts tests/ledger/capability-uses.test.ts` (codec round-trips; locate the capability-uses test file by grep if named differently). Typecheck gate.

- [ ] **Step 5: Commit**

```bash
git add src/processors/executor.ts src/cli/commands/inspect.ts tests/
git commit -m "feat(ledger): cap stored effect hashes at 100 with count sentinel; inspect reports true totals

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: correct the invariant prose + spec sweep

**Files:**
- Modify: `docs/wiki/invariants/EVERY_EFFECT_IS_LEDGERED.md`, `docs/wiki/specs/run-ledger.md`
- Test: `bun test tests/integration/invariant-coverage.test.ts` (lockstep unaffected — prose-only)

**Interfaces:** none — docs only.

- [ ] **Step 1: Rewrite the false mechanism claims in `EVERY_EFFECT_IS_LEDGERED.md`**

Read the whole doc first. Keep the Statement (every emission traceable). Replace the passages claiming (a) `src/engine/core/apply-effect.ts` calls `ledger.recordEffect()` per effect, and (b) hashes are "joined back … the union is the complete audit history", with the real mechanism: the executor computes `effects.map(hashEffect)` once per run, capped at `EFFECT_HASHES_MAX = 100` with a `…+N more effect hashes` sentinel; `markSucceeded` persists the list on the run row; the CONTENT record for each effect lives in its typed sink (git commits joined by `Dome-Run`; facts/diagnostics/questions in projection.db; external actions in outbox.db), keyed by `runId`; the run row's list is a fingerprint-and-count index, not a verification primitive. Bump `updated:` to 2026-07-05.

- [ ] **Step 2: Sweep `run-ledger.md`** — the effect-hashes row/prose (~line 27 "what the run produced, even when no commit was made", and the schema description if it lists the column): add the cap + sentinel in one sentence. Bump `updated:`.

- [ ] **Step 3: Verify + commit** — `grep -rn "recordEffect" docs/ src/` → zero hits outside historical (docs/cohesive, docs/superpowers); `bun test tests/integration/invariant-coverage.test.ts` → PASS; typecheck gate.

```bash
git add docs/wiki/invariants/EVERY_EFFECT_IS_LEDGERED.md docs/wiki/specs/run-ledger.md
git commit -m "docs(invariant): EVERY_EFFECT_IS_LEDGERED describes the real hash mechanism (capped batch, sinks hold content)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** cap + boundary + sentinel (T1) ✓; honest inspect count incl. malformed fallback (T1) ✓; codec round-trips at both codecs (T1 Step 1/4) ✓; invariant + spec prose (T2) ✓; no DDL/migration (constraint) ✓.

**Placeholder scan:** executor test fixtures reference "mirror the file's fixture style" — the exact assertion values are given; the sentinel literal, regex, and constant appear identically in impl, helper, and tests.

**Type consistency:** `effectHashCount(ReadonlyArray<string>): number` defined in executor.ts, imported by inspect.ts; `EFFECT_HASHES_MAX` referenced only in executor.ts + tests.
