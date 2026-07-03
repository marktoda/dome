# Sweep Escalations as Diagnostics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert `dome.agent.sweep`'s three `escalate:`-type owner questions into `warning` diagnostics (they are `[skip]`-only notices with a dead no-op answer handler over durable ledger rows), keeping the `uncertain→integrate` question untouched.

**Architecture:** Swap `questionEffect`→`diagnosticEffect` at the three escalate emit sites in `sweep.ts`; retire the dead `escalate` branch of `sweep-answer.ts`; sweep the normative docs. The ledger writes (`escalated`/`questioned` dispositions) and queue-exclusion contract are unchanged — only the owner-facing surface moves.

**Tech Stack:** TypeScript on Bun; `bun test`.

## Global Constraints

- The three escalate sites emit `DiagnosticEffect`, `severity: "warning"`, with distinct stable codes: `dome.agent.sweep.escalate-failures`, `dome.agent.sweep.dest-too-large`, `dome.agent.sweep.material-too-large`. Never `error`/`block`.
- `sourceRefs: itemRefs` (the `[material, destination]` pair) is unchanged on each.
- Diagnostics carry no `options`, no `idempotencyKey`, no `metadata.automationPolicy`.
- Each escalate site keeps its existing `ledgerRows.push({ ...row, disposition: "escalated" | "questioned" })` and `continue` — byte-for-byte. The ledger/settlement model is out of scope.
- The `uncertain→integrate` question (`sweepIdempotencyKey("uncertain", item)`, `options: ["integrate","skip"]`, `proposedSection`) is untouched, and `sweep-answer.ts`'s uncertain handling + its `dome.agent.sweep:`-prefix trigger are untouched.
- `dome.agent.sweep` keeps its `question.ask` grant (the uncertain question needs it). No manifest grant change.
- Typecheck filter: `bun run tsc --noEmit 2>&1 | grep -v "open-store.test.ts"` (a pre-existing unrelated error; your change must add zero new errors).

---

### Task 1: sweep.ts escalate sites emit diagnostics

**Files:**
- Modify: `assets/extensions/dome.agent/processors/sweep.ts`
- Test: `tests/extensions/dome.agent/sweep.test.ts`

**Interfaces:**
- Consumes: `diagnosticEffect` (already imported, `sweep.ts:31`), `itemRefs` (local `[ctx.sourceRef(item.material), ctx.sourceRef(item.destination)]`).
- Produces: `dome.agent.sweep` emits `warning` diagnostics with codes `dome.agent.sweep.escalate-failures` / `.dest-too-large` / `.material-too-large` for the three escalate cases; no `QuestionEffect` for those cases.

- [ ] **Step 1: Rewrite the escalate test assertions (RED)**

In `tests/extensions/dome.agent/sweep.test.ts`, three tests currently assert escalate **questions** via the `questions(effects)` helper + `idempotencyKey` of `dome.agent.sweep:escalate:...`. Rewrite each to assert a **diagnostic** via the existing `diagnostics(effects)` helper. The test fixtures/setup stay; only the post-run assertions change.

For `test("escalation: failedCount >= 3 skips the model and asks the owner (options: skip)", ...)` (~line 435) — rename to `"escalation: failedCount >= 3 skips the model and emits a warning diagnostic"` and replace the question assertions with:

```typescript
    const escalations = diagnostics(effects).filter(
      (d) => d.code === "dome.agent.sweep.escalate-failures",
    );
    expect(escalations.length).toBe(1);
    expect(escalations[0]!.severity).toBe("warning");
    expect(escalations[0]!.message).toContain("failed attempts");
    expect(effects.some((e) => (e as { kind: string }).kind === "question")).toBe(false);
```
Keep the existing assertion that an `:: escalated` ledger row is written (the ledger behavior is unchanged).

For `test("C2a: a destination beyond the read window skips the agent run and escalates to the owner", ...)` (~line 790) — replace the question assertion with:

```typescript
    const escalations = diagnostics(effects).filter(
      (d) => d.code === "dome.agent.sweep.dest-too-large",
    );
    expect(escalations.length).toBe(1);
    expect(escalations[0]!.severity).toBe("warning");
    expect(effects.some((e) => (e as { kind: string }).kind === "question")).toBe(false);
```

Find the material-oversize counterpart test (the one asserting an escalate question for `MATERIAL_READ_CHARS` / material beyond the window) and replace its question assertion analogously with `code === "dome.agent.sweep.material-too-large"`.

For `test("an escalated pair stays settled on the next run: no re-question, no model call, ...", ...)` (~line 474) — it asserts no re-emission on the next run; update any "no question" assertion to also cover "no escalate diagnostic" (the pair is excluded from the queue, so neither is re-emitted):

```typescript
    expect(
      diagnostics(effects).some((d) => d.code?.startsWith("dome.agent.sweep.escalate") || d.code === "dome.agent.sweep.dest-too-large" || d.code === "dome.agent.sweep.material-too-large"),
    ).toBe(false);
```

Leave the `uncertain` question test (`"question path: recordUncertainIntegration → owner-needed QuestionEffect ..."`, ~line 390) UNCHANGED.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/extensions/dome.agent/sweep.test.ts`
Expected: FAIL — the escalate cases still emit `questionEffect`, so the `diagnostics(...)` filters are empty and the `no question` assertions fail.

- [ ] **Step 3: Swap the three escalate emit sites to diagnostics**

In `sweep.ts`, replace the **failure-threshold** emit (the `if (item.failedCount >= ESCALATE_AFTER_FAILURES) { ... }` block):

```typescript
        effects.push(
          diagnosticEffect({
            severity: "warning",
            code: "dome.agent.sweep.escalate-failures",
            message: `Sweep keeps failing on ${item.material} -> ${item.destination} (${item.failedCount} failed attempts); integrate it manually, or it stays unswept until you re-arm the pair by deleting its ledger row.`,
            sourceRefs: itemRefs,
          }),
        );
        ledgerRows.push({ ...row, disposition: "escalated" });
        continue;
```

Replace the **destination-too-large** emit (`if (destContent.length > MAX_READ_CHARS) { ... }`):

```typescript
        effects.push(
          diagnosticEffect({
            severity: "warning",
            code: "dome.agent.sweep.dest-too-large",
            message: `Sweep cannot safely integrate ${item.material} -> ${item.destination}: the destination is ${destContent.length} chars, beyond the sweep's ${MAX_READ_CHARS}-char read window (a full-page rewrite from a truncated read would amputate the tail); integrate it manually, or it stays unswept until you re-arm the pair by deleting its ledger row.`,
            sourceRefs: itemRefs,
          }),
        );
        ledgerRows.push({ ...row, disposition: "questioned" });
        continue;
```

Replace the **material-too-large** emit (`if (materialContent.length > MATERIAL_READ_CHARS) { ... }`):

```typescript
        effects.push(
          diagnosticEffect({
            severity: "warning",
            code: "dome.agent.sweep.material-too-large",
            message: `Sweep cannot safely integrate ${item.material} -> ${item.destination}: the material is ${materialContent.length} chars, beyond the sweep's ${MATERIAL_READ_CHARS}-char material read window (integrating from a truncated read would settle the pair with the tail never seen; "no capture left behind" violation); integrate it manually, or it stays unswept until you re-arm the pair by deleting its ledger row.`,
            sourceRefs: itemRefs,
          }),
        );
        ledgerRows.push({ ...row, disposition: "questioned" });
        continue;
```

Leave the `uncertain` `pendingQuestion` emit (the `questionEffect` with `options: ["integrate","skip"]`) UNCHANGED — `questionEffect` stays imported and used.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/extensions/dome.agent/sweep.test.ts`
Expected: PASS (escalate cases now emit the warning diagnostics; the uncertain question test still passes).

- [ ] **Step 5: Typecheck**

Run: `bun run tsc --noEmit 2>&1 | grep -v "open-store.test.ts"`
Expected: no new errors. (`sweepIdempotencyKey("escalate", …)` is now uncalled but the helper remains — that is fine; do not delete it.)

- [ ] **Step 6: Commit**

```bash
git add assets/extensions/dome.agent/processors/sweep.ts tests/extensions/dome.agent/sweep.test.ts
git commit -m "feat(sweep): escalations surface as warning diagnostics, not [skip]-only questions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Retire the dead escalate answer branch + sweep the docs

**Files:**
- Modify: `assets/extensions/dome.agent/processors/sweep-answer.ts`
- Test: `tests/extensions/dome.agent/sweep-answer.test.ts`
- Modify: `docs/wiki/specs/sweep.md`

**Interfaces:**
- Consumes: nothing new.
- Produces: `sweep-answer.ts` handles only the `uncertain` namespace; `dome.agent.sweep` no longer documents escalate-as-question anywhere normative.

- [ ] **Step 1: Update sweep-answer tests (RED for the removal)**

In `tests/extensions/dome.agent/sweep-answer.test.ts`, delete the `describe("escalate-key answer", ...)` block (~line 215, the test "any answer value → zero effects") and the now-unused `ESCALATE_KEY` constant (~line 26). Leave all `uncertain` / `skip` / metadata-validation / envelope tests unchanged.

- [ ] **Step 2: Remove the dead escalate branch from sweep-answer.ts**

In `sweep-answer.ts`:
- Delete the `if (keyKind === "escalate") { return Object.freeze([]); }` block (with its comment).
- Delete the `ESCALATE_PREFIX` constant.
- Simplify `discriminateKey` to return `"uncertain" | "unknown"` (drop the `escalate` arm); update the `KeyKind` type accordingly. A pre-migration escalate answer now falls through to `unknown` → `[]` (same no-op).

- [ ] **Step 3: Run the sweep-answer + sweep suites**

Run: `bun test tests/extensions/dome.agent/sweep-answer.test.ts tests/extensions/dome.agent/sweep.test.ts`
Expected: PASS.

- [ ] **Step 4: Sweep `docs/wiki/specs/sweep.md`**

This page describes escalations as questions in several places. Update them to reflect the diagnostics design (do NOT change anything about the ledger dispositions, settlement, queue exclusion, or the `uncertain` question):

- The `questioned` ledger-grammar row (~line 67): change "a QuestionEffect was emitted for the owner" → "a `warning` diagnostic was emitted for the owner".
- The `escalated` row (~line 69) and the paragraph at ~line 71: change "written alongside the escalation question" / "ride an escalation-shaped question" → "…escalation diagnostic". Keep the `escalated` vs `questioned` distinction and the manual re-arm contract intact.
- Oversized-destination guard (~line 99): change "a `dome.agent.sweep:escalate:<m>-><d>` question is emitted asking the owner to integrate manually or skip" → "a `warning` diagnostic (`code: dome.agent.sweep.dest-too-large`) is emitted; the owner integrates manually or re-arms by deleting the ledger row".
- Oversized-material guard (~line 101): change the "question with `options: ["skip"]`, `automationPolicy: "owner-needed"`" phrasing → "`warning` diagnostic (`code: dome.agent.sweep.material-too-large`)".
- The §"Questions" / namespaces section (~lines 107–110): rewrite so it states sweep emits ONE question namespace — `dome.agent.sweep:uncertain:<m>-><d>` (options `["integrate","skip"]`, carries `proposedSection`) — and that escalations (repeated-failure + the two size guards) now surface as `warning` **diagnostics** (codes `dome.agent.sweep.escalate-failures` / `.dest-too-large` / `.material-too-large`), not questions, and have no answer handler. Keep the `uncertain` integrate-handler description (~line 114) unchanged.
- If the frontmatter `updated:` field exists, set it to `2026-06-27`.

- [ ] **Step 5: Check the bundle matrices + grep for stragglers**

Run: `grep -rn "sweep:escalate\|escalation question\|escalate.*question\|escalate-key" docs/wiki/`
For any normative hit (e.g. `docs/wiki/matrices/extension-bundle-shape.md`, `built-in-extensions-x-phase.md`) that describes a sweep *escalate question* or a `sweep` *escalate answer* path, update it to diagnostics. Note: `sweep-answer` still EXISTS (handles `uncertain`) and `dome.agent.sweep` still holds `question.ask` — do not remove those references; only correct claims that escalations are questions. Historical docs under `docs/cohesive/` and `docs/superpowers/` are NOT swept.

- [ ] **Step 6: Verify + typecheck**

Run: `bun test tests/extensions/dome.agent/sweep.test.ts tests/extensions/dome.agent/sweep-answer.test.ts tests/cli/commands/check.test.ts` → expect PASS.
Run: `bun run tsc --noEmit 2>&1 | grep -v "open-store.test.ts"` → expect no new errors.
Run: `grep -rn "escalate" docs/wiki/specs/sweep.md` → confirm no remaining description of escalations as *questions* (mentions of `escalated` ledger rows / the escalation *contract* are fine and expected).

- [ ] **Step 7: Commit**

```bash
git add assets/extensions/dome.agent/processors/sweep-answer.ts tests/extensions/dome.agent/sweep-answer.test.ts docs/wiki/specs/sweep.md docs/wiki/matrices/
git commit -m "refactor(sweep): retire dead escalate answer branch; sweep escalation docs to diagnostics

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Three escalate sites → warning diagnostics (distinct codes), uncertain untouched → Task 1. ✓
- Retire escalate answer branch → Task 2 Steps 1–3. ✓
- Ledger dispositions/queue exclusion unchanged → Task 1 Step 3 keeps `ledgerRows.push` + `continue` verbatim; called out as a constraint. ✓
- Normative-doc sweep → Task 2 Steps 4–5. ✓
- Capability unchanged (`question.ask` stays) → Global Constraints + Task 2 Step 5 note. ✓
- Acceptance: escalate emits no QuestionEffect (Task 1 Step 1 asserts `no question`); suite green (Tasks 1/2); docs no longer call escalations questions (Task 2 Step 6 grep). ✓

**Placeholder scan:** Test edits reference exact test names + give the exact new assertion code; the doc edits give the exact before/after phrasing per line. The material-oversize test in Task 1 Step 1 is referenced by description ("the one asserting an escalate question for MATERIAL_READ_CHARS") rather than a line number — the implementer locates it by the `material-too-large` / `MATERIAL_READ_CHARS` assertion; this is the one search step in the plan and is explicitly flagged.

**Type consistency:** Codes match between emitter (Task 1 Step 3) and assertions (Task 1 Step 1): `dome.agent.sweep.escalate-failures`, `dome.agent.sweep.dest-too-large`, `dome.agent.sweep.material-too-large`. `severity: "warning"` is a valid `DiagnosticEffect` severity. `discriminateKey`'s `KeyKind` narrows to `"uncertain" | "unknown"` consistently in Task 2 Step 2.
