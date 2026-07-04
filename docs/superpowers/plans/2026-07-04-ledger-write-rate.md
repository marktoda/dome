# Ledger Write-Rate Reduction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop writing the run-ledger's fat tail: cap each trigger's stored `matchedSignals` at 50 (+ truncation marker) and slow the `dome.health` recovery trio from every minute to every 5 minutes.

**Architecture:** One pure-function change at the single payload construction site (`triggerPayloadOf`, `src/processors/runtime.ts:1603`) — no reader parses the column's structure, so only JSON well-formedness must hold. One manifest cadence change. `effect_hashes_json` untouched.

**Tech Stack:** TypeScript on Bun; `bun test`.

## Global Constraints

- `MATCHED_SIGNALS_MAX = 50` per trigger entry. When truncated, append ONE marker element of the SAME `{signal, path}` shape: `{ signal: "dome.ledger.truncated", path: "…+<dropped> more matched signals" }` where `<dropped>` is the true dropped count. ≤50 signals → byte-identical output (no marker).
- The trigger declaration is never truncated; multiple trigger entries truncate independently.
- The three `dome.health` crons become exactly `"*/5 * * * *"`. No other manifest change.
- `effect_hashes_json` and the ledger schema are untouched.
- Typecheck gate: `bun run tsc --noEmit 2>&1 | grep -v "open-store.test.ts"` → zero new errors.

---

### Task 1: cap matchedSignals in triggerPayloadOf

**Files:**
- Modify: `src/processors/runtime.ts` (`triggerPayloadOf`, ~line 1595-1610, including its now-stale doc comment promising "the full match list is stored")
- Test: `tests/processors/runtime-ledger.test.ts` (the file asserting persisted ledger rows from runtime dispatch)

**Interfaces:**
- Consumes: `TriggerMatch` (`src/processors/triggers.ts`), whose `matchedSignals` elements are `{ signal, path }`.
- Produces: same function signature; capped output. Exported constant not required (module-private const is fine — nothing else needs it), but export `MATCHED_SIGNALS_MAX` if the test cannot otherwise reference 50 without a magic number.

- [ ] **Step 1: Write the failing tests**

In `tests/processors/runtime-ledger.test.ts` (mirror its existing dispatch-then-read-ledger-row pattern; it already asserts on persisted rows):

```typescript
test("trigger payload stores at most 50 matched signals per trigger, with a truncation marker", async () => {
  // Drive a dispatch whose trigger matched 120 signal events (use the file's
  // existing fixture mechanism for building TriggerMatch inputs — if dispatch
  // fan-in can't cheaply produce 120 matches, test triggerPayloadOf directly:
  // export it for tests OR assert via the persisted row after a dispatch with
  // a synthetic 120-event match list, whichever the file's seams support).
  const payload = row.triggerPayload as ReadonlyArray<{
    trigger: unknown;
    matchedSignals: ReadonlyArray<{ signal: string; path: string }>;
  }>;
  expect(payload[0]!.matchedSignals.length).toBe(51); // 50 + marker
  expect(payload[0]!.matchedSignals[50]).toEqual({
    signal: "dome.ledger.truncated",
    path: "…+70 more matched signals",
  });
});

test("trigger payload with ≤50 matched signals is stored unchanged (no marker)", async () => {
  // 3 matched signals → exactly 3 entries, none named dome.ledger.truncated
});

test("multiple triggers truncate independently", async () => {
  // trigger A: 120 signals → 51 stored; trigger B: 2 signals → 2 stored
});
```

If dispatch-level fan-in is awkward to synthesize, the clean seam is exporting `triggerPayloadOf` (rename-free, add `export` + a doc note "exported for tests") and unit-testing it directly with hand-built `TriggerMatch[]`, PLUS one dispatch-level test asserting the persisted row round-trips as valid JSON. Choose whichever the file's existing seams make honest; say which in the report.

- [ ] **Step 2: RED** — run the file; the new tests fail (full list stored today).

- [ ] **Step 3: Implement**

```typescript
/** Cap on stored matched-signal events per trigger entry. The full fan-in of
 * a bulk adoption (thousands of {signal, path} pairs duplicated into every
 * subscribed processor's row) was 75% of trigger-payload bytes in 1.4% of
 * rows; past this cap the payload records a marker with the dropped count
 * instead. No reader parses the payload structurally (row codec validates
 * well-formedness only), so the cap is an audit-granularity bound, not a
 * behavior change. */
const MATCHED_SIGNALS_MAX = 50;

function triggerPayloadOf(
  matches: ReadonlyArray<TriggerMatch>,
): ReadonlyArray<{ readonly trigger: TriggerMatch["trigger"]; readonly matchedSignals: TriggerMatch["matchedSignals"] }> {
  return matches.map((m) => {
    if (m.matchedSignals.length <= MATCHED_SIGNALS_MAX) {
      return { trigger: m.trigger, matchedSignals: m.matchedSignals };
    }
    const dropped = m.matchedSignals.length - MATCHED_SIGNALS_MAX;
    return {
      trigger: m.trigger,
      matchedSignals: [
        ...m.matchedSignals.slice(0, MATCHED_SIGNALS_MAX),
        {
          signal: "dome.ledger.truncated",
          path: `…+${dropped} more matched signals`,
        },
      ] as TriggerMatch["matchedSignals"],
    };
  });
}
```

(If the `as` cast fights the `Signal` literal type on `signal`, widen the return type of the payload's `matchedSignals` to `ReadonlyArray<{ readonly signal: string; readonly path: string }>` instead of casting — the payload type is local to this function's return and nothing downstream consumes it structurally.)

Update the function's doc comment: the full match list is NO LONGER stored past the cap; the marker carries the dropped count.

- [ ] **Step 4: GREEN + guardrails** — the file passes; also run `bun test tests/ledger/runs.test.ts tests/processors/runtime.test.ts` (codec round-trip + ProcessorContext surface unaffected). Typecheck gate.

- [ ] **Step 5: Commit**

```bash
git add src/processors/runtime.ts tests/processors/runtime-ledger.test.ts
git commit -m "feat(ledger): cap stored matched signals at 50 per trigger with truncation marker

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: health trio to */5

**Files:**
- Modify: `assets/extensions/dome.health/manifest.yaml` (lines 9, 35, 58: `cron: "* * * * *"` → `cron: "*/5 * * * *"`)
- Test: `tests/extensions/manifest-schema.test.ts` (should pass untouched); grep-check for pins
- Docs: any normative wiki page stating the health trio's cadence (`grep -rn "every minute\|\* \* \* \* \*" docs/wiki/` — update hits that describe dome.health's cron; historical docs stay)

**Interfaces:** none — manifest-only.

- [ ] **Step 1: Change the three cron lines**, then `grep -n "cron" assets/extensions/dome.health/manifest.yaml` → all three read `"*/5 * * * *"`.

- [ ] **Step 2: Verify nothing pinned the old cadence** — run `bun test tests/extensions/manifest-schema.test.ts tests/engine/scheduler.test.ts tests/cli/commands/check.test.ts` (scheduler tests use their own fixtures; check.test's maintenance-loop assertions name processors, not crons — if any assertion DOES pin the health cron, update it to `*/5`). Sweep `docs/wiki/` per the Files note and update normative cadence mentions.

- [ ] **Step 3: Typecheck + commit**

```bash
git add assets/extensions/dome.health/manifest.yaml docs/wiki/ tests/
git commit -m "feat(health): recovery-question trio runs every 5 minutes, not every minute

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** payload cap + marker + comment update (T1) ✓; cadence ×3 + doc sweep (T2) ✓; effect_hashes untouched (constraint) ✓; acceptance criteria 1-3 map to T1 tests / T2 grep / constraint ✓.

**Placeholder scan:** Step 1's test sketch flags the one genuine seam decision (dispatch-fan-in vs exported-function unit test) explicitly and requires the implementer to report which; the marker literal and counts are exact.

**Type consistency:** the widened `matchedSignals` element type (if needed) is local to `triggerPayloadOf`'s return; `MATCHED_SIGNALS_MAX = 50` appears once; marker literal `dome.ledger.truncated` consistent between impl and tests.
