# Integrity Findings as Diagnostics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `dome.warden.integrity` surface its findings as diagnostics (the correct, self-clearing bucket) instead of owner-needed questions with a dead no-op answer handler.

**Architecture:** The warden is a `kind:"llm"` garden processor. Today both its emit sites (deterministic claim-collisions and filtered model findings) emit `QuestionEffect`, and a terminal no-op handler (`integrity-answer`) "answers" them. Switch both sites to `DiagnosticEffect` with risk-mapped severity (`high→warning`, else `info`), retire the dead handler, and drop the now-unused `question.ask` grant. Diagnostics are ungated (broker: "diagnostic → always allow") and self-clear via `resolveStaleDiagnostics` when the page is re-inspected and the finding is gone.

**Tech Stack:** TypeScript on Bun; `bun test`; isomorphic project (no new deps).

## Global Constraints

- Severity mapping: `high → "warning"`, `medium → "info"`; `low` findings are already dropped upstream. Never `error`/`block` (must not gate adoption).
- Diagnostics carry no automation policy / idempotencyKey; identity is `code` + subject-hash. Use a stable `code` per finding kind.
- The warden must remain compliant with `MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS`: it keeps `read` + `model.invoke`, never `graph.write`, and now emits only `DiagnosticEffect` (non-durable, regenerated each garden run — same transience its questions had).
- Do NOT touch `promptForPage` (the model prompt) — `tests/integration/agent-prompt-regression.test.ts` snapshots it and it is out of scope.
- Out of scope (separate fast-follows): the dormant auto-resolution path; sweep size-guard escalations.

---

### Task 1: Integrity warden emits diagnostics instead of questions

**Files:**
- Modify: `assets/extensions/dome.warden/processors/integrity.ts`
- Test: `tests/extensions/warden-integrity.test.ts`

**Interfaces:**
- Consumes: `diagnosticEffect` (already imported, `src/core/effect.ts`), `Finding` (local type; `severity: QuestionRisk`), `Collision` (local type), `FINDING_LABEL`, `collisionRecommendedAnswer`.
- Produces: `dome.warden.integrity` now emits `DiagnosticEffect` only. Diagnostic codes: `"dome.warden.integrity.claim-collision"` for collisions and `` `dome.warden.integrity.${finding.kind}` `` for model findings.

- [ ] **Step 1: Rewrite the warden-integrity test assertions to expect diagnostics**

In `tests/extensions/warden-integrity.test.ts`, replace the three emission tests' question assertions. The fixture setup (the `ctx` builder + `modelInvoke` stub) stays unchanged; only the post-`run` assertions change.

Replace the body of `test("drops low-risk findings — only risk >= medium becomes a question", ...)` assertions (was `questions.length === 1`, `risk === "medium"`) with:

```typescript
    const diagnostics = effects.filter((e) => e.kind === "diagnostic");
    expect(diagnostics.length).toBe(1);
    // medium risk → info severity
    expect(diagnostics[0]?.severity).toBe("info");
    expect(effects.some((e) => e.kind === "question")).toBe(false);
```

Replace the `test("high-severity finding on a people page ...")` body (rename it `"high-severity finding → warning DiagnosticEffect, no question/fact/patch"`) with:

```typescript
    const diagnostics = effects.filter((e) => e.kind === "diagnostic");
    expect(diagnostics.length).toBe(1);
    const d = diagnostics[0];
    if (d === undefined) throw new Error("expected a diagnostic");
    expect(effects.some((e) => e.kind === "question")).toBe(false);
    expect(effects.some((e) => e.kind === "fact")).toBe(false);
    expect(effects.some((e) => e.kind === "patch")).toBe(false);
    expect(d.severity).toBe("warning"); // high risk → warning
    expect(d.code).toBe("dome.warden.integrity.historical-as-ongoing");
    expect(d.message).toContain(path);
    expect(d.message).toContain("shipped last quarter"); // folded recommendedAnswer
    expect(d.sourceRefs.length).toBe(1);
    expect(d.sourceRefs[0]?.path as string).toBe(path);
```

Replace `test("non-people page → agent-safe QuestionEffect", ...)` — delete it (people/agent-safe distinction no longer exists for diagnostics). Add in its place:

```typescript
  test("deterministic claim-collision → warning diagnostic", async () => {
    // Reuse this file's collision fixture (a page with two conflicting claim
    // values for the same key). Build ctx as the other tests do, with
    // ctx.projection.facts returning the colliding CLAIM_PREDICATE facts.
    const effects = await integrity.run(ctx);
    const collisions = effects.filter(
      (e) => e.kind === "diagnostic" && e.code === "dome.warden.integrity.claim-collision",
    );
    expect(collisions.length).toBe(1);
    expect(collisions[0]?.severity).toBe("warning");
    expect(effects.some((e) => e.kind === "question")).toBe(false);
  });
```

The `no findings → emits nothing` and `modelInvoke unavailable/throws → no-op` tests stay as-is (they already assert `effects.length === 0` / `[]`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/extensions/warden-integrity.test.ts`
Expected: FAIL — current code emits `question` effects, so `e.kind === "diagnostic"` filters are empty and `e.kind === "question"` is `true`.

- [ ] **Step 3: Add the severity mapper and reframe the message helpers**

In `integrity.ts`, add near the other helpers:

```typescript
/** Risk → diagnostic severity. `low` is dropped upstream; `high` warns, the rest inform. */
function severityForRisk(risk: QuestionRisk): "warning" | "info" {
  return risk === "high" ? "warning" : "info";
}
```

Replace `collisionQuestionText` with a statement-shaped message that folds in the recommended fix:

```typescript
function collisionDiagnosticMessage(path: string, collision: Collision): string {
  return (
    `Claim contradiction in ${path}: the key "${collision.key}" is asserted ` +
    `with conflicting values ${collision.values.map((v) => `"${v}"`).join(" vs ")}. ` +
    `Suggested fix: ${collisionRecommendedAnswer(collision)}`
  );
}
```

Replace `questionTextFor` with:

```typescript
function findingDiagnosticMessage(path: string, finding: Finding): string {
  return (
    `Integrity flag in ${path}: ${FINDING_LABEL[finding.kind]}. ` +
    `Claim: "${finding.claim}". Suggested fix: ${finding.recommendedAnswer}`
  );
}
```

- [ ] **Step 4: Switch both emit sites to diagnostics**

In the `run` body, replace the collision emit loop:

```typescript
      for (const [, collision] of pageCollisions) {
        effects.push(
          diagnosticEffect({
            severity: "warning", // hard mechanical contradiction
            code: "dome.warden.integrity.claim-collision",
            message: collisionDiagnosticMessage(path, collision),
            sourceRefs: [ctx.sourceRef(path)],
          }),
        );
      }
```

Replace the model-finding emit loop's `effects.push(questionEffect({...}))` with (keep the three `continue` guards above it unchanged):

```typescript
        effects.push(
          diagnosticEffect({
            severity: severityForRisk(finding.severity),
            code: `dome.warden.integrity.${finding.kind}`,
            message: findingDiagnosticMessage(path, finding),
            sourceRefs: [ctx.sourceRef(path)],
          }),
        );
```

Delete the now-unused locals in the `for (const path ...)` body: `contentHash`, `policy`, `ownerNeededMeta`, and the `isPeopleContent` call. Delete the `isPeopleContent` function. Remove `questionEffect` and `QuestionAutomationPolicy` from the imports (keep `diagnosticEffect`, `QuestionRisk`, `Effect`). Keep `shortHash` only if still referenced elsewhere; if not, remove its import too.

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test tests/extensions/warden-integrity.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `bun run tsc --noEmit 2>&1 | grep -v "open-store.test.ts"`
Expected: no errors in `integrity.ts` (the `open-store.test.ts` line, if present, is a pre-existing unrelated error — ignore it).

- [ ] **Step 7: Commit**

```bash
git add assets/extensions/dome.warden/processors/integrity.ts tests/extensions/warden-integrity.test.ts
git commit -m "feat(warden): integrity surfaces findings as risk-mapped diagnostics, not questions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Retire the dead answer handler, drop the unused grant, sync the invariant doc

**Files:**
- Delete: `assets/extensions/dome.warden/processors/integrity-answer.ts`
- Delete: `tests/extensions/warden-integrity-answer.test.ts`
- Modify: `assets/extensions/dome.warden/manifest.yaml`
- Modify: `docs/wiki/invariants/MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS.md`

**Interfaces:**
- Consumes: nothing (removal task).
- Produces: `dome.warden` bundle now has a single processor (`dome.warden.integrity`) with capabilities `read` + `model.invoke` (no `question.ask`).

- [ ] **Step 1: Remove the integrity-answer processor and its manifest entry**

Delete `assets/extensions/dome.warden/processors/integrity-answer.ts`.

In `assets/extensions/dome.warden/manifest.yaml`, delete the entire `- id: dome.warden.integrity-answer` processor block (its `triggers`, `capabilities`, `module`). Also remove the `- kind: question.ask` line from the `dome.warden.integrity` capabilities (it no longer emits questions). The integrity processor's capabilities become exactly:

```yaml
    capabilities:
      - kind: read
        paths: ["wiki/**/*.md"]
      - kind: model.invoke
        maxDailyCostUsd: 10
```

- [ ] **Step 2: Delete the dead handler's test**

```bash
git rm tests/extensions/warden-integrity-answer.test.ts
```

- [ ] **Step 3: Update the invariant doc prose to match**

In `docs/wiki/invariants/MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS.md`, the structural-enforcement section names the warden's capabilities. Replace the sentence:

> The shipped warden follows this: `dome.warden.integrity` declares `read` + `model.invoke` + `question.ask` (questions only — no patch and no graph.write).

with:

> The shipped warden follows this: `dome.warden.integrity` declares `read` + `model.invoke` (no `graph.write`, no `patch.auto`). Its findings surface as `DiagnosticEffect`s — transient model judgment that regenerates each garden run and self-clears when the page is reconciled, so nothing durable is lost on rebuild.

Do not change the invariant statement, the test-guarantee section, or `REBUILD_SAFE_GARDEN_CAPABILITIES` (the rule still holds — integrity holds `model.invoke`, never `graph.write`).

- [ ] **Step 4: Run the manifest/bundle and invariant suites**

Run: `bun test tests/extensions/manifest-schema.test.ts tests/invariants/model-processors-emit-no-durable-facts.test.ts tests/integration/invariant-coverage.test.ts`
Expected: PASS (the manifest is valid with one processor; the invariant test asserts no garden `model.invoke` processor declares `graph.write` — still true).

- [ ] **Step 5: Run the broader scoped suite to catch fallout**

Run: `bun test tests/extensions/warden-integrity.test.ts tests/cli/commands/inspect.test.ts tests/cli/commands/check.test.ts tests/integration/agent-prompt-regression.test.ts tests/engine/health-grant-starvation.test.ts tests/harness/scenarios/effect-routing/model-provider-failure.scenario.test.ts`
Expected: PASS. (These were verified not to reference the integrity-answer handler or the `question.ask` grant: `inspect.test.ts` lists model processors — integrity keeps `model.invoke`; `health-grant-starvation` builds its own fixtures from integrity's `read` grant; `agent-prompt-regression` snapshots `promptForPage`, untouched.) If any fails, the fix is to remove a now-stale reference to `dome.warden.integrity-answer`; do not re-add the handler.

- [ ] **Step 6: Typecheck**

Run: `bun run tsc --noEmit 2>&1 | grep -v "open-store.test.ts"`
Expected: no errors (no dangling import of the deleted module).

- [ ] **Step 7: Commit**

```bash
git add -A assets/extensions/dome.warden tests/extensions docs/wiki/invariants/MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS.md
git commit -m "refactor(warden): retire dead integrity-answer handler + unused question.ask grant

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Integrity emits diagnostics not questions (risk-mapped severity, stable code, self-clear) → Task 1. ✓
- Retire `integrity-answer` + manifest grant + lockstep doc → Task 2. ✓
- Remaining question emitters untouched → no task needed; verified by Task 2 Step 5. ✓
- Acceptance: integrity emits zero `QuestionEffect` (Task 1 Step 1 asserts `no question`); lockstep green (Task 2 Step 4); work-vault open-question count drops after rebuild (operational consequence, observed post-merge — not a unit test). ✓

**Placeholder scan:** No TBD/TODO; every code step shows the code. The one soft spot — the collision-test fixture — is anchored to "this file's existing collision fixture"; if the existing test file has no collision fixture, build `ctx.projection.facts` to return two `CLAIM_PREDICATE` facts with the same key and different values for one path (the shape `collisionKeysByPath` consumes).

**Type consistency:** `severityForRisk(risk: QuestionRisk)` returns `"warning" | "info"`, matching `DiagnosticEffect.severity`'s allowed values. Codes are consistent between Task 1 (emitter) and Task 1 Step 1 (test assertion): `dome.warden.integrity.claim-collision` and `dome.warden.integrity.<kind>`. `Finding.severity` is `QuestionRisk` (`"low"|"medium"|"high"`), consumed by `severityForRisk`. ✓
