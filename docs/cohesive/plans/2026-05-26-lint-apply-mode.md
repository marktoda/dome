# `dome lint --apply <id>` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `dome lint` with a `--apply <id>` mode (repeatable for multi-id) that re-invokes the lint workflow with `apply <id1> <id2> ...` as the user message; the workflow (already two-mode per `src/prompts/builtin/lint.md`) reads the latest report and executes the recommendation.

**Architecture:** Three implementation surfaces:

1. **`src/reconcile.ts`** — export the existing `isDirtyGitState` helper so apply-mode can reuse the same mid-merge / mid-rebase / mid-cherry-pick guard as `dome reconcile`.
2. **`src/cli/commands/lint.ts`** — extend `domeLint(vaultPath, opts, applyIds?)` to accept an optional ids array, reject empty ids, gate apply-mode behind the dirty-git-state guard, and build the user message `apply <id1> <id2> ...`. Propose mode (no ids) keeps the empty user message it has today.
3. **`src/cli/cli.ts`** — add a repeatable `--apply <id>` option using commander's collector pattern, wire the action to call `domeLint(..., applyIds)`, and parse the workflow's summary text for non-`applied` outcomes to derive the multi-id exit code per `wiki/specs/cli.md:131`.

The CLI stays under 600 LOC per `wiki/specs/cli.md §"Implementation note"`. The lint workflow prompt is already two-mode and dispatches on user-message shape — no prompt changes in this pass.

**Tech Stack:** TypeScript on Bun. CLI uses commander.js (already in deps). Tests use `bun:test` + `MockLanguageModelV3` from `ai/test` (same pattern as `tests/cli/migrate-bootstrap.test.ts`).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/reconcile.ts` | Modify | Export `isDirtyGitState` (currently private at line 140) so lint apply-mode can reuse the same guard. |
| `src/cli/commands/lint.ts` | Modify | Accept optional `applyIds` parameter; reject empty ids with validation error; gate apply-mode on `!isDirtyGitState`; construct user message. |
| `src/cli/cli.ts` | Modify | Add `--apply <id>` repeatable option; update the lint action to collect ids, call `domeLint`, parse summary for non-applied outcomes, derive exit code. |
| `tests/cli/lint.test.ts` | Create | 4 CLI surface tests (TC1–TC4) covering propose mode, single apply, multi-id apply, and empty-id rejection. |

**Out of scope (deferred per delta ledger §"Tests proposed" — V1+):**
- The 7 workflow-prompt fixture tests under `tests/prompts/lint/`. No fixture harness exists at `tests/prompts/` for full workflow execution today; the proper home for those fixtures is a separate piece of work.
- Strict per-id structured output from the workflow. v0.5's multi-id exit code uses substring matching (`Apply-failed:` / `refused`) against the workflow's free-text summary. A structured result schema is a follow-up.

---

## Task 1: Export `isDirtyGitState` for reuse

**Files:**
- Modify: `src/reconcile.ts:140`

- [ ] **Step 1: Write the failing test**

Create a small test asserting the function is importable from `src/reconcile.ts`. This pins the export contract so future refactors don't accidentally re-privatize it.

Append to `tests/reconcile.test.ts` (or create a new test if no such file exists — check first with `ls tests/reconcile.test.ts`):

```typescript
import { describe, test, expect } from "bun:test";
import { isDirtyGitState } from "../src/reconcile";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("isDirtyGitState (exported)", () => {
  test("returns false for a clean repo (no merge/rebase markers)", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-dirty-state-"));
    try {
      await mkdir(join(base, ".git"), { recursive: true });
      expect(isDirtyGitState(base)).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("returns true when .git/MERGE_HEAD exists", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-dirty-state-"));
    try {
      await mkdir(join(base, ".git"), { recursive: true });
      await writeFile(join(base, ".git", "MERGE_HEAD"), "abc123");
      expect(isDirtyGitState(base)).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/reconcile.test.ts`
Expected: FAIL with `Module has no exported member 'isDirtyGitState'` (or similar TS error).

- [ ] **Step 3: Export `isDirtyGitState`**

In `src/reconcile.ts:140`, change:

```typescript
function isDirtyGitState(vaultPath: string): boolean {
```

to:

```typescript
export function isDirtyGitState(vaultPath: string): boolean {
```

No other changes — the function body stays identical.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/reconcile.test.ts`
Expected: PASS (both new tests, plus existing reconcile tests still pass).

- [ ] **Step 5: Commit**

```bash
git add src/reconcile.ts tests/reconcile.test.ts
git commit -m "feat(reconcile): export isDirtyGitState for lint apply-mode reuse"
```

---

## Task 2: Extend `domeLint` to accept `applyIds`

**Files:**
- Modify: `src/cli/commands/lint.ts:7-12`
- Test: covered by Tasks 5–8 (the CLI surface tests in `tests/cli/lint.test.ts` exercise this surface directly)

- [ ] **Step 1: Write the failing test (defer to Task 5)**

Task 2's behavior is exercised by TC1 (Task 5) and TC2 (Task 6). Skip this step's standalone test — proceed to Step 3 and use Task 5's test to drive the change. (Strict TDD purity would have a standalone unit test for `domeLint`'s message construction, but the CLI surface tests cover the same contract through `runCli` more meaningfully — they pin the end-to-end behavior the spec promises.)

- [ ] **Step 2: (skipped — see Step 1)**

- [ ] **Step 3: Extend `domeLint`**

Replace the entire body of `src/cli/commands/lint.ts` with:

```typescript
import { WorkflowName } from "../../workflows/workflow-name";
import type { RunWorkflowOpts } from "../../workflows/agent-loop";
import { runWorkflowAtPath } from "../run-workflow-at-path";
import { isDirtyGitState } from "../../reconcile";
import { err, type Result } from "../../types";
import type { CliError } from "../cli-error";

/**
 * Run the lint workflow against the vault.
 *
 * Two modes (per wiki/specs/cli.md §"dome lint"):
 *
 * - Propose mode (default): `applyIds` is undefined or empty. The workflow
 *   walks the vault and writes a structured report under
 *   `inbox/review/lint-report-YYYY-MM-DD.md` (when sensitivity routing is
 *   enabled) or returns the report inline.
 *
 * - Apply mode (`applyIds` is a non-empty array): re-invokes the workflow
 *   with the user message `apply <id1> <id2> ...`. The workflow (per
 *   src/prompts/builtin/lint.md §"Apply mode") locates the most recent
 *   report, finds each finding by id, and executes the recommendation via
 *   writeDocument/moveDocument/deleteDocument — every mutation auto-logged
 *   per EVERY_WRITE_IS_LOGGED.
 *
 * Apply mode refuses to run if the vault is mid-merge/rebase/cherry-pick
 * (same guard as `dome reconcile` per wiki/gotchas/dirty-git-state-at-reconcile).
 *
 * Empty ids (`applyIds` contains an empty string) are a CLI usage error —
 * surfaced before any workflow dispatch.
 */
export async function domeLint(
  vaultPath: string,
  opts: RunWorkflowOpts = {},
  applyIds?: ReadonlyArray<string>,
): Promise<Result<{ steps: number; text: string }, CliError>> {
  const isApplyMode = applyIds !== undefined && applyIds.length > 0;

  if (isApplyMode) {
    // Reject empty strings BEFORE any disk / network work. Empty ids would
    // construct user messages like "apply  H2" which the workflow can't
    // resolve; surface as a usage error at the boundary instead.
    for (const id of applyIds!) {
      if (id.length === 0) {
        return err({
          kind: "validation",
          message: "lint --apply requires a non-empty finding id (got empty string)",
        });
      }
    }

    // Mid-merge guard: apply-mode mutates the vault, so the same
    // dirty-git-state refusal that protects reconcile applies here too.
    // Propose mode is read-only and doesn't need this guard.
    if (isDirtyGitState(vaultPath)) {
      return err({
        kind: "validation",
        message:
          "Vault is in a dirty git state (mid-merge/rebase/cherry-pick). Resolve before applying lint findings.",
      });
    }
  }

  // User message protocol matches src/prompts/builtin/lint.md §"Apply mode":
  // empty string -> propose mode; "apply <id1> <id2> ..." -> apply mode.
  const userMessage = isApplyMode ? `apply ${applyIds!.join(" ")}` : "";

  return runWorkflowAtPath(vaultPath, WorkflowName.Lint, userMessage, opts);
}
```

- [ ] **Step 4: Run all tests to verify nothing already-passing broke**

Run: `bun test tests/cli/`
Expected: PASS for all existing tests. The `missing-api-key.test.ts` test that calls `domeLint(vaultPath)` (line 60) still works because `applyIds` is optional.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/lint.ts
git commit -m "feat(cli): domeLint accepts applyIds for two-mode invocation

Propose mode (no ids, default) preserves the empty user message.
Apply mode (one or more ids) builds 'apply <id1> <id2> ...' and routes
to the workflow's apply branch. Empty ids are rejected at the CLI boundary;
apply mode refuses on mid-merge/rebase state per the reconcile guard.
"
```

---

## Task 3: Add `--apply <id>` flag to the lint command in `cli.ts`

**Files:**
- Modify: `src/cli/cli.ts:236-257`

- [ ] **Step 1: Write the failing test (TC2 — apply H1)**

Create `tests/cli/lint.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { domeInit } from "../../src/cli/commands/init";
import { domeLint } from "../../src/cli/commands/lint";

function makeNoopMockModel() {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text: "lint complete" }],
      finishReason: { unified: "stop", raw: "end_turn" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

// Read user-message text from a captured doGenerate call. User content is
// an array of parts (text / image / tool-result); we keep only the text
// parts so assertions can do substring matches.
function readUserMessage(call: { prompt: ReadonlyArray<{ role: string; content: unknown }> }): string {
  const userMsg = call.prompt.find((m) => m.role === "user");
  if (!userMsg || !Array.isArray(userMsg.content)) return "";
  return userMsg.content
    .filter(
      (p): p is { type: "text"; text: string } =>
        typeof p === "object" && p !== null && (p as { type: string }).type === "text",
    )
    .map((p) => p.text)
    .join("");
}

describe("dome lint two-mode invocation", () => {
  // TC2 — apply H1 dispatches with user message "apply H1"
  test("apply mode with one id sends 'apply H1' to the workflow", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-lint-apply-"));
    const target = join(base, "v");
    try {
      const initRes = await domeInit(target);
      expect(initRes.ok).toBe(true);

      const mock = makeNoopMockModel();
      const res = await domeLint(target, { model: mock, skipCommit: true }, ["H1"]);
      expect(res.ok).toBe(true);

      expect(mock.doGenerateCalls.length).toBeGreaterThanOrEqual(1);
      const user = readUserMessage(mock.doGenerateCalls[0]!);
      expect(user).toContain("apply H1");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/lint.test.ts`
Expected: FAIL — the test imports `domeLint` with the new signature; if Task 2 was committed first, the test should pass here too. If Task 2 hasn't been done yet, the test fails because `domeLint` doesn't take applyIds. (This task assumes Task 2 landed first; that's why it's sequenced after Task 2.)

- [ ] **Step 3: Wire the `--apply` flag into the CLI lint command**

In `src/cli/cli.ts`, replace the lint section (lines 235-257) with:

```typescript
  // ------ lint ------
  // --apply collector: commander invokes this for each --apply occurrence
  // (apply <id>); we accumulate into an array so multi-id (--apply H1
  // --apply H2) becomes ["H1", "H2"].
  const collectApply = (value: string, prev: string[]): string[] => [...prev, value];

  program
    .command("lint")
    .description("Run the lint workflow against the vault (semantic; LLM-driven).")
    .option(
      "--apply <id>",
      "Apply a finding from the most recent lint report by id (repeatable: --apply H1 --apply H2)",
      collectApply,
      [] as string[],
    )
    .addHelpText(
      "after",
      [
        "",
        "Two modes:",
        "  Propose (default)  — walks the wiki and writes a structured report",
        "                        with findings tagged by stable id (H1, M2, ...)",
        "                        to inbox/review/lint-report-YYYY-MM-DD.md.",
        "  Apply (--apply ID) — executes a single named recommendation from",
        "                        the most recent report. Repeatable for multi-id.",
        "",
        "Apply mode refuses to run during a mid-merge / mid-rebase /",
        "mid-cherry-pick (same guard as `dome reconcile`).",
        "",
        "For deterministic structural checks (no LLM), use `dome doctor`.",
        "",
        "Requires ANTHROPIC_API_KEY.",
      ].join("\n"),
    )
    .action(async (opts: { apply: string[] }) => {
      // Apply ids come from commander's repeatable-option collector;
      // empty array means propose mode.
      const applyIds = opts.apply.length > 0 ? opts.apply : undefined;
      const r = await domeLint(process.cwd(), {}, applyIds);
      if (!r.ok) {
        console.error(renderCliError(r.error));
        // Validation errors (empty id, mid-merge guard) are usage-shaped;
        // openVault / model failures are runtime-shaped. The error kind
        // already encodes the distinction.
        outcome.code = r.error.kind === "validation" ? ExitCode.Usage : ExitCode.Failure;
        return;
      }
      if (r.value.text.length > 0) console.log(r.value.text);
      console.error(`lint complete: ${r.value.steps} step(s)`);

      // Multi-id exit-code semantics per wiki/specs/cli.md §"Apply mode":
      // exit nonzero if any id reported failed/refused. The workflow's
      // summary text is free-form; substring match against the two
      // canonical annotation markers from src/prompts/builtin/lint.md
      // §"Apply mode" Step 5 ("Apply-failed:" or "(advisory)" refusals
      // typically include the word "refused").
      if (applyIds !== undefined) {
        const lower = r.value.text.toLowerCase();
        if (lower.includes("apply-failed") || lower.includes("refused")) {
          outcome.code = ExitCode.Failure;
        }
      }
    });
```

- [ ] **Step 4: Run TC2 to verify it passes**

Run: `bun test tests/cli/lint.test.ts`
Expected: PASS (the TC2 test).

- [ ] **Step 5: Commit**

```bash
git add src/cli/cli.ts tests/cli/lint.test.ts
git commit -m "feat(cli): add --apply <id> to dome lint (repeatable for multi-id)

Commander collector accumulates ids into an array; the action passes
applyIds to domeLint() which constructs 'apply <id1> <id2> ...' as the
workflow user message. Empty array means propose mode (current behavior).
Multi-id exit code derives from substring match on Apply-failed / refused
in the workflow summary per wiki/specs/cli.md apply-mode semantics.
"
```

---

## Task 4: Add TC1 — propose mode test

**Files:**
- Modify: `tests/cli/lint.test.ts`

- [ ] **Step 1: Add the failing test**

Append to the `describe("dome lint two-mode invocation", ...)` block in `tests/cli/lint.test.ts`:

```typescript
  // TC1 — propose mode (no applyIds) sends empty user message
  test("propose mode (no --apply) sends empty user message to the workflow", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-lint-propose-"));
    const target = join(base, "v");
    try {
      const initRes = await domeInit(target);
      expect(initRes.ok).toBe(true);

      const mock = makeNoopMockModel();
      const res = await domeLint(target, { model: mock, skipCommit: true });
      expect(res.ok).toBe(true);

      expect(mock.doGenerateCalls.length).toBeGreaterThanOrEqual(1);
      const user = readUserMessage(mock.doGenerateCalls[0]!);
      // Propose mode kickoff: the user message is the empty string the
      // CLI passes when no --apply was given. Trim() drops the vault
      // prologue's trailing whitespace if any.
      expect(user.trim()).toBe("");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run to verify it passes**

Run: `bun test tests/cli/lint.test.ts`
Expected: PASS (already passes against the implementation from Tasks 2 + 3 — TC1 verifies the propose-mode contract holds).

- [ ] **Step 3: Commit**

```bash
git add tests/cli/lint.test.ts
git commit -m "test(cli): TC1 — dome lint propose mode sends empty user message"
```

---

## Task 5: Add TC3 — multi-id apply test

**Files:**
- Modify: `tests/cli/lint.test.ts`

- [ ] **Step 1: Add the failing test**

Append to the `describe` block in `tests/cli/lint.test.ts`:

```typescript
  // TC3 — multi-id (--apply H1 --apply H2) sends "apply H1 H2"
  test("apply mode with multiple ids sends 'apply H1 H2' to the workflow", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-lint-multi-"));
    const target = join(base, "v");
    try {
      const initRes = await domeInit(target);
      expect(initRes.ok).toBe(true);

      const mock = makeNoopMockModel();
      const res = await domeLint(target, { model: mock, skipCommit: true }, ["H1", "H2"]);
      expect(res.ok).toBe(true);

      expect(mock.doGenerateCalls.length).toBeGreaterThanOrEqual(1);
      const user = readUserMessage(mock.doGenerateCalls[0]!);
      // Order-preserving join with single-space separator matches the
      // workflow prompt's apply-mode dispatch shape.
      expect(user).toContain("apply H1 H2");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run to verify it passes**

Run: `bun test tests/cli/lint.test.ts`
Expected: PASS (the implementation from Task 2 already constructs `apply ${applyIds.join(" ")}` which produces `apply H1 H2`).

- [ ] **Step 3: Commit**

```bash
git add tests/cli/lint.test.ts
git commit -m "test(cli): TC3 — dome lint multi-id sends 'apply H1 H2'"
```

---

## Task 6: Add TC4 — empty `--apply` rejection test

**Files:**
- Modify: `tests/cli/lint.test.ts`

- [ ] **Step 1: Add the failing test**

Append to the `describe` block:

```typescript
  // TC4 — empty --apply id is rejected at the CLI boundary with a
  // validation error (no workflow dispatch).
  test("apply mode rejects empty id with validation error before workflow dispatch", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-lint-empty-"));
    const target = join(base, "v");
    try {
      const initRes = await domeInit(target);
      expect(initRes.ok).toBe(true);

      const mock = makeNoopMockModel();
      const res = await domeLint(target, { model: mock, skipCommit: true }, [""]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.kind).toBe("validation");
        expect(res.error.message.toLowerCase()).toContain("non-empty");
      }
      // No workflow dispatch happened — the mock model was never called.
      expect(mock.doGenerateCalls.length).toBe(0);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run to verify it passes**

Run: `bun test tests/cli/lint.test.ts`
Expected: PASS (the implementation from Task 2 includes the empty-id rejection at the top of apply-mode).

- [ ] **Step 3: Commit**

```bash
git add tests/cli/lint.test.ts
git commit -m "test(cli): TC4 — dome lint --apply '' rejected at CLI boundary"
```

---

## Task 7: Add `runCli`-level test for the `--apply` parser wiring

**Files:**
- Modify: `tests/cli/cli.test.ts`

This exercises the commander surface (not just the `domeLint` function) so the `--apply <id>` repeatable parser is pinned. Without this, a regression that broke commander's option collection would only fail at the integration level.

- [ ] **Step 1: Add the failing test**

Append to the `describe("runCli", ...)` block in `tests/cli/cli.test.ts`:

```typescript
  test("lint --apply <id> parses without usage error (dispatch is wired)", async () => {
    // cwd is a fresh dir which is NOT a vault, so lint will fail with
    // Failure (vault not openable), not Usage — proving the --apply flag
    // parsed correctly. A Usage exit would mean commander rejected the
    // flag.
    const base = await mkdtemp(join(tmpdir(), "dome-cli-apply-"));
    const origCwd = process.cwd();
    try {
      process.chdir(base);
      const code = await runCli(["lint", "--apply", "H1"]);
      // Validation-shaped error in domeLint maps to Usage; runtime
      // (vault not openable) maps to Failure. We pass --apply H1 (valid)
      // against a non-vault cwd, so the failure happens at vault-open,
      // not at apply-id validation — hence Failure.
      expect(code).toBe(ExitCode.Failure);
    } finally {
      process.chdir(origCwd);
      await rm(base, { recursive: true, force: true });
    }
  });

  test("lint --apply <id> --apply <id2> collects multiple ids (commander repeatable wiring)", async () => {
    // Same shape as above; the test passes if commander accepts the
    // repeated --apply without flagging it as unknownOption.
    const base = await mkdtemp(join(tmpdir(), "dome-cli-multi-"));
    const origCwd = process.cwd();
    try {
      process.chdir(base);
      const code = await runCli(["lint", "--apply", "H1", "--apply", "H2"]);
      expect(code).toBe(ExitCode.Failure); // not Usage — multi-id parses
    } finally {
      process.chdir(origCwd);
      await rm(base, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run to verify it passes**

Run: `bun test tests/cli/cli.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/cli/cli.test.ts
git commit -m "test(cli): runCli pins --apply <id> repeatable wiring (commander surface)"
```

---

## Task 8: Verify and document the existing lint dispatch test still passes

**Files:**
- Modify: `tests/cli/cli.test.ts:54-67` (the existing "lint dispatches to domeLint" test)

This is a regression-safety task — confirm the existing test that exercises `runCli(["lint"])` (with no `--apply`) still passes after the CLI changes. No code change expected; if it fails, debug.

- [ ] **Step 1: Run the full CLI test suite**

Run: `bun test tests/cli/`
Expected: ALL PASS. Specifically the existing `"lint dispatches to domeLint"` test (cli.test.ts:54) should pass — propose mode is the default and behaves exactly as before when no `--apply` is given.

- [ ] **Step 2: If any test fails, debug and fix; if all pass, commit nothing (this task is verify-only)**

No commit unless a fix was needed. If a fix was needed, commit it with a message describing the regression and the fix.

---

## Task 9: Final type-check + full test sweep

**Files:**
- (None — verification only)

- [ ] **Step 1: Run TypeScript type check**

Run: `bun tsc --noEmit`
Expected: no type errors. (If `bun tsc` isn't available, run via the project's configured type-check command — check `package.json` `scripts`.)

- [ ] **Step 2: Run the full test suite**

Run: `bun test`
Expected: ALL PASS. Tests touching the lint surface are in:
- `tests/reconcile.test.ts` (isDirtyGitState export)
- `tests/cli/lint.test.ts` (TC1–TC4)
- `tests/cli/cli.test.ts` (existing lint dispatch + new --apply parser wiring)
- `tests/cli/missing-api-key.test.ts` (existing domeLint test — must still pass because applyIds is optional)

- [ ] **Step 3: Spot-check the CLI help text**

Run: `bun bin/dome lint --help` (or `node bin/dome lint --help` depending on the bin shape)
Expected: help text shows the new `--apply <id>` option with the two-mode description.

- [ ] **Step 4: Commit any drift fixes**

If type-check or tests revealed drift, fix and commit. Otherwise, no commit needed.

---

## Self-Review Checklist

- **Spec coverage:**
  - `wiki/specs/cli.md §"Apply mode (--apply <id>)"` — covered by Tasks 2, 3 (CLI surface + domeLint plumbing).
  - `wiki/specs/cli.md` multi-id semantics — covered by Task 3 (substring exit-code derivation) and Task 5 (TC3).
  - `wiki/specs/cli.md` mid-merge refusal — covered by Task 2 (gate in `domeLint`) + Task 1 (export).
  - `wiki/specs/cli.md` empty-id rejection — covered by Task 2 (gate in `domeLint`) + Task 6 (TC4).
  - `wiki/specs/prompts-and-workflows.md §lint row` — covered (no code change needed; the prompt is already updated).
  - `wiki/matrices/intent-prompt-tools.md §lint row` — covered (no code change needed).
  - `src/prompts/builtin/lint.md` — already updated in the Lock pass; no code change in Build.
  - Tests proposed (4 CLI surface) — covered by Tasks 4, 5, 6, 7.
  - Tests proposed (7 workflow-prompt fixtures) — explicitly deferred per delta ledger; documented in File Structure §"Out of scope."

- **Placeholder scan:** No TODOs, no "implement later," no "similar to Task N." Every code block carries the actual code.

- **Type consistency:** `applyIds?: ReadonlyArray<string>` in `domeLint` matches `opts.apply: string[]` from commander's collector (commander returns mutable arrays; we accept readonly to widen the contract). The user-message format `apply <id1> <id2> ...` matches `src/prompts/builtin/lint.md §"Apply mode"` line 52 byte-for-byte. The mid-merge guard message reuses the same phrasing pattern as `src/reconcile.ts:43-46`.
