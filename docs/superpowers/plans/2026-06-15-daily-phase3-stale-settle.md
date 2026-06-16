# Daily Phase 3 — Stale-Settle (finish the attention path) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use `- [ ]` checkboxes.

**Goal:** Turn the existing (informal, unresolvable) stale-loop handling into a structured, resolvable decision: surface long-overdue / heavily-discounted tasks as ONE owner question per task with close / defer / keep options, and a deterministic answer-handler that applies the disposition. Propose-not-auto; no new staleness channel.

**Architecture:** This *finishes* the existing attention path, it does not add one. The deterministic `dome.attention.discount` facts already mark surfaced-without-action tasks (`ATTENTION_STALE_THRESHOLD = 0.4`). Add a **deterministic** garden processor `dome.daily.stale-task-warden` that, per task that is BOTH overdue beyond a threshold (default 14 days) AND discounted ≥ 0.4, emits ONE `QuestionEffect` (idempotencyKey `dome.daily.settle-stale:<stableId>`, options `["close","defer","keep"]`, metadata carrying `{path, anchor, dueDate}`). A deterministic `answer`-triggered handler `dome.daily.settle-stale-answer` (the established `sweep-answer` pattern) applies: **close** → patch the origin line to `[-]` (reconcile propagates); **defer** → bump the `📅 YYYY-MM-DD` due date forward; **keep** → no patch (the answered question's idempotency suppresses recurrence). Both processors are deterministic (no `model.invoke`) — staleness is a clock/threshold fact, not model judgment — so this honors deterministic-where-possible and propose-not-auto.

**Tech Stack:** TypeScript on Bun; `bun test`; `dome.daily` bundle; the warden/answer-handler pattern (mirror `dome.agent.sweep-answer`).

**Design:** `docs/cohesive/brainstorms/2026-06-15-daily-phase2.md` §"P3".

**Key facts (verified):**
- `dome.attention.discount` facts: predicate `ATTENTION_DISCOUNT_PREDICATE`, threshold const `ATTENTION_STALE_THRESHOLD = 0.4` (`dome.daily/processors/attention-shared.ts`). The fact JSON value shape is documented there (read it for the discount value + the task's path/anchor via sourceRef).
- Answer-handler pattern (`dome.agent.sweep-answer`, manifest lines ~218-234): `trigger: { kind: answer, questionProcessorId: <emitting processor id>, idempotencyKeyPrefix: <prefix> }`; deterministic; `parseAnswerInput` from `lib/answer-input.ts` parses the envelope; emits a PatchEffect for the disposition; retry-idempotent (check-before-write).
- Task identity: `^id` block anchor; due dates render as `📅 YYYY-MM-DD`; top-priority `🔺` and dated tasks are discount-exempt (so a stale-overdue task with a due date in the past is the target — note: the discount EXEMPTS dated tasks, so "overdue + discounted" may be rare; see Task 1's threshold logic, which uses overdue-OR-discount, reconciled below).
- `reconcile-tasks` propagates a settled `[-]`/`[x]` state from a daily copy back to the origin; a `close` that writes `[-]` on the origin line settles everywhere.
- Manifest grants: a question-emitting processor needs `question.ask`; the answer-handler needs `patch.auto` for the daily/source paths it edits + `question.ask` is not needed. Mirror `sweep`/`sweep-answer` grant shapes.

**IMPORTANT threshold reconciliation (resolve in Task 1):** `dome.attention.discount` EXEMPTS tasks that carry a due date (discount forced to 0 for `📅`-dated tasks). So "overdue AND discount ≥ 0.4" is contradictory for dated tasks. Resolve: the warden targets a task when EITHER (a) it is overdue (`📅` date < today) by ≥ 14 days, OR (b) it is undated but discounted ≥ 0.4 (surfaced ≥ ~6× without action). Two stale signals, one question. The threshold + the OR are config-able consts. Confirm the exact attention-fact shape and due-date extraction when implementing.

---

### Task 1: `dome.daily.stale-task-warden` — emit the structured settle question

**Files:**
- Create: `assets/extensions/dome.daily/processors/stale-task-warden.ts`
- Modify: `assets/extensions/dome.daily/manifest.yaml` (register the processor + grants)
- Modify: a lockstep/registration test if the bundle pins processor lists (check `tests/extensions/` + `tests/integration` for a manifest-lockstep test, like the claims bundle had)
- Test: `tests/extensions/dome.daily/stale-task-warden.test.ts`

- [ ] **Step 1: Read the patterns**
Read `dome.daily/processors/attention-shared.ts` (the discount fact value shape + threshold), `action-state.ts` (`collectDailyActionState` / how overdue + due dates are computed from a task — reuse `taskMetadata`/due parsing), and `dome.agent/processors/sweep.ts` + manifest for the question-emit + grant shape. Determine how to get, per stale task: its `stableId`, source `path`, `^anchor`, and `dueDate`.

- [ ] **Step 2: Write the failing test**
A deterministic unit test over the processor: given a snapshot/projection with (a) an overdue-by-≥14-days dated task and (b) an undated discounted task, the processor emits exactly one `dome.daily.settle-stale:<stableId>` QuestionEffect each, options `["close","defer","keep"]`, with metadata `{path, anchor, dueDate?}` and `automationPolicy: "owner-needed"`. A fresh (non-stale) task emits none. Re-run with the question already answered/resolved → no re-emit (idempotencyKey stable). Model the test on the existing deterministic-processor tests in `tests/extensions/dome.daily/` (read one for the ctx/projection harness).

- [ ] **Step 3: Run, expect FAIL** (processor module missing).

- [ ] **Step 4: Implement the processor** (`defineProcessorImplementation`): read the attention facts (`ctx.projection.facts({ predicate: ATTENTION_DISCOUNT_PREDICATE })`) and the task surface (reuse the action-extraction/action-state helpers to get dated/overdue tasks). For each task matching the stale rule (overdue ≥ `STALE_OVERDUE_DAYS=14`, OR undated with discount ≥ `ATTENTION_STALE_THRESHOLD`), emit:
```ts
questionEffect({
  question: `Stale: "${shortBody}" has been ${reason} — close it, defer it, or keep tracking?`,
  options: ["close", "defer", "keep"],
  idempotencyKey: `dome.daily.settle-stale:${stableId}`,
  sourceRefs: [ctx.sourceRef(path, lineRange(line), stableId)],
  metadata: { path, ...(anchor ? { anchor } : {}), ...(dueDate ? { dueDate } : {}), risk: "low", automationPolicy: "owner-needed", recommendedAnswer: "keep" },
})
```
Phase: garden (a view/read of adopted state → question); `execution.class: deterministic` (rebuild-safe; pure function of adopted tree + clock-via-`ctx.now()` — note: if a wall clock is used for "overdue ≥ 14d", confirm whether that breaks rebuild-determinism; if so, gate on `ctx.now()` like create-daily's schedule, and document it's clock-dependent like the daily lifecycle crons rather than `deterministic`). Grant: `question.ask`.

- [ ] **Step 5: Register in manifest** with grants; update any manifest-lockstep test. Add a `dome.daily.settle-stale:` invariant/doc note if the bundle pins question namespaces.

- [ ] **Step 6: Run, expect PASS** (unit + manifest lockstep). Commit:
```bash
git add assets/extensions/dome.daily/processors/stale-task-warden.ts assets/extensions/dome.daily/manifest.yaml tests
git commit -m "feat(dome.daily): stale-task-warden — structured settle-stale question for stale/overdue tasks"
```

---

### Task 2: `dome.daily.settle-stale-answer` — apply the disposition

**Files:**
- Create: `assets/extensions/dome.daily/processors/settle-stale-answer.ts`
- Modify: `assets/extensions/dome.daily/manifest.yaml` (register; `answer` trigger on `dome.daily.stale-task-warden`, prefix `dome.daily.settle-stale:`; grant `patch.auto` for `wiki/**`/`notes/**`/`wiki/dailies/*` as needed)
- Test: `tests/extensions/dome.daily/settle-stale-answer.test.ts`

- [ ] **Step 1: Write the failing test**
Given an answered question (`dome.daily.settle-stale:<id>` with answer `close`/`defer`/`keep`) and the source file content, assert:
- `close` → emits a PatchEffect changing the origin task line from `- [ ] …` to `- [-] …` (preserving the `^anchor` + origin marker).
- `defer` → bumps the `📅 YYYY-MM-DD` due date forward by `DEFER_DAYS=7` (or adds one if absent), preserving the rest of the line.
- `keep` → emits NO patch (no-op; the resolved question suppresses recurrence).
- Retry-idempotent: re-running `close` when the line is already `[-]` emits no second patch.
Model on `tests/extensions/dome.agent/sweep-answer.test.ts` (read it for the answer-input harness).

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement** (mirror `sweep-answer.ts`): `parseAnswerInput`, discriminate on the answer value, read the source line at the question's sourceRef (path + range/anchor from metadata), compute the edited line (close: `[ ]`→`[-]`; defer: rewrite/append the `📅` date), and emit ONE PatchEffect — or none for `keep` / for an already-settled line (check-before-write idempotence). Deterministic, no model. Use the shared line/anchor helpers from `action-extraction` (e.g. `parseBlockAnchor`, the origin-marker-aware body) so the edit preserves anchor + marker.

- [ ] **Step 4: Run, expect PASS.** Commit:
```bash
git add assets/extensions/dome.daily/processors/settle-stale-answer.ts assets/extensions/dome.daily/manifest.yaml tests
git commit -m "feat(dome.daily): settle-stale-answer — close/defer/keep applies the owner's disposition"
```

---

### Task 3: Spec + governance + full suite

**Files:**
- Modify: `docs/wiki/specs/task-lifecycle.md` (§"Attention discounting" / §"Wardens" — document the settle-stale warden + answer-handler) and/or `daily-surface.md`
- Modify: `docs/wiki/specs/daily-surface.md` block/section tables if the warden/answer-handler writes a daily region (it edits source task lines, not a generated block — confirm whether a table row is needed; the warden only ASKS, the answer-handler patches the origin line which already has owners)

- [ ] **Step 1: Document** the stale-settle loop in task-lifecycle.md (the warden pattern instance): deterministic threshold (overdue ≥ 14d OR discount ≥ 0.4) → one `settle-stale` question (close/defer/keep) → deterministic answer-handler applies it; propose-not-auto; settlement durable via answers.db + the origin-line patch. Link `[[cohesive/brainstorms/2026-06-15-daily-phase2]]`. Use the file's wikilink convention.

- [ ] **Step 2: AC3 lockstep** — if `tests/integration/invariant-coverage.test.ts` or a manifest-lockstep test requires a test/doc per shipped processor, ensure both new processors satisfy it (add the invariant doc/test row if the bundle requires it; check how the claims bundle's processors were registered).

- [ ] **Step 3: Full suite** `bun test 2>&1 | tail -6` → 0 fail. Watch `tests/extensions/dome.daily/*`, `tests/integration` (manifest lockstep, wikilink resolution, invariant coverage).

- [ ] **Step 4: Commit**
```bash
git add docs/wiki/specs tests
git commit -m "docs(daily): document the stale-settle warden loop (Phase 3); lockstep"
```

---

## Self-review notes
- **Finishes, not forks:** builds on the existing `dome.attention.discount` facts + the warden+answer-handler pattern (`sweep-answer`). No new staleness channel.
- **Deterministic where possible:** both processors are deterministic (threshold/clock, not model judgment); honors `MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS` trivially (no model).
- **Propose-not-auto:** the warden only asks; the answer-handler only acts on the owner's disposition. No auto-close.
- **One question per task, idempotent:** keyed on `stableId`; an answered question never re-emits.
- **Threshold reconciliation:** overdue-OR-discount resolves the dated-task discount-exemption (Task 1 IMPORTANT note).
- **Open: clock-determinism.** If "overdue ≥ 14d" uses a wall clock, the warden is clock-dependent (like the daily crons), NOT rebuild-`deterministic`; Task 1 Step 4 resolves the manifest class accordingly.

## NOTE on scope
This plan deliberately does NOT cluster related loops (the design cut that). The warden may MENTION related loops in the question text as context, but Dome does not auto-group. Keep it to one task per question.
