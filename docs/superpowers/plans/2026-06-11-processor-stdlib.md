# Processor Stdlib + Bundle Decomposition (Review Item 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the helper logic duplicated across extension bundles into shared `src/core/` modules, decompose the 2,094-line `daily-shared.ts` into focused modules behind a re-export barrel, and stage `export-context.ts` — all with **byte-identical behavior** (anchors are durable identity in committed markdown; the fixed-point loop depends on deterministic output).

**Architecture:** Characterization tests FIRST pin today's exact behavior — including the divergences between the claims and daily variants (fence-indent tolerance, blockquote exclusion, anchor hash inputs, validator message strings). Then mechanical moves: shared primitives land in `src/core/` (the established home bundles already import from — `block-anchor.ts`, `generated-block.ts`, `compare.ts`), per-bundle semantics stay in the bundles as thin adapters, and `daily-shared.ts` becomes a barrel so **no consumer import changes** are needed.

**Tech Stack:** Bun + bun:test; no new dependencies. Bundles import `src/core/` via the existing `../../../../src/core/<module>` relative-path convention.

**Branch:** `worktree-processor-stdlib+build` (worktree at `.claude/worktrees/processor-stdlib+build`). `--no-ff` merge into `main` when done.

**Hard rules for every task:**
- Behavior-preserving only. A divergence between the claims and daily variants is **by design until proven otherwise** — preserve it, never silently unify. If you believe a divergence is a bug, report it as a finding; do not fix it on this branch.
- Anchor IDs (`^t…`, `^c…`) must be byte-identical before and after. They live in committed user markdown; changing them re-identifies every task/claim in every vault.
- Error message strings from config validators must be byte-identical (they surface in diagnostics).
- `bun test` green after every task; full suite (~2068 tests) is the gate before merge.

**Verified facts this plan relies on** (from the 2026-06-11 inventory; re-verify when touching):
- Bundles import SDK code via relative paths like `../../../../src/core/block-anchor`; the purity fence (`tests/integration/processor-purity.test.ts`) checks mutation imports/calls, not paths — new pure `src/core/` modules are importable from bundles.
- `claims-shared.ts` (~188 lines): `excludedLineFlags(lines): boolean[]` — frontmatter + fences via `/^[ ]{0,3}(`{3,}|~{3,})/` (0–3 leading spaces allowed); claims extraction ALSO skips blockquote lines; `claimAnchorId` hashes `JSON.stringify([path.replace(/^\.\//, ""), normalizeClaimKey(key), occurrence])` → sha256 hex `.slice(0, 8)`, prefix `c`; `stampClaimAnchors` dedupes against all existing anchor ids.
- `daily-shared.ts`: `frontmatterLineRange(content)` (lines ~1928-1939) returns `{start,end}|null`; `fencedCodeBlockLineRanges(content)` (~1904-1926) uses `/^(`{3,}|~{3,})/` on `trimStart()`ed lines — wait, verify: the inventory says daily has NO leading-space allowance; confirm whether daily matches on the raw line or trimStart; preserve whichever it is. `taskAnchorId` hashes `JSON.stringify([normalizeSourcePath(path), normalizeOpenLoopBody(body), occurrence])`, prefix `t`; `stampTaskAnchors` does NOT dedupe and skips Obsidian-Tasks dashboards.
- Config validators: `coreMemoryPath` (dome.agent/lib/core-memory.ts:54-76) and `consolidationLedgerPath` (dome.agent/processors/consolidate.ts:48-72) are the SAME gauntlet with different field names, returning `{path, problem}`; `dailyPathSettings`/`validateDailyPathTemplate` (daily-shared.ts:240-266) THROWS, adds the `{date}` placeholder rule, message prefix `dome.daily config daily_path`.
- `dome.search` already has a lib layer (`recall.ts`, `ranking.ts`, `related.ts`, `labels.ts`, `topic-relevance.ts`); `export-context.ts` helpers `renderMarkdown` (~770-877) and `renderOverview` (~878-946) are the render layer.
- Pinning tests exist: `tests/extensions/daily-shared.test.ts`, `tests/processors/claims-grammar.test.ts`, `claims-stamp.test.ts`, `tests/extensions/dome.agent/core-memory.test.ts`, plus the daily/claims/search harness scenarios.

---

### Task 1: Characterization tests (pin current behavior, including the divergences)

**Files:**
- Create: `tests/core/markdown-scan-characterization.test.ts`
- Create: `tests/core/anchor-id-stability.test.ts`
- Create: `tests/core/config-path-messages.test.ts`

These tests import from the CURRENT bundle locations and must pass UNCHANGED before and after every subsequent task (only their import paths may be updated in later tasks if a symbol's canonical home moves — the assertions never change).

- [ ] **Step 1: Write the markdown-scan characterization test**

```ts
// tests/core/markdown-scan-characterization.test.ts
//
// Pins the EXACT line-exclusion semantics of the claims and daily markdown
// scanners — including their divergences (fence indent tolerance, blockquote
// handling). The processor-stdlib refactor must not change any of these
// observable behaviors: anchors and extraction identity in committed vaults
// depend on them.

import { describe, expect, test } from "bun:test";

import { excludedLineFlags } from "../../assets/extensions/dome.claims/processors/claims-shared";
import {
  fencedCodeBlockLineRanges,
  frontmatterLineRange,
} from "../../assets/extensions/dome.daily/processors/daily-shared";

const FIXTURE = [
  "---",            // 0  frontmatter open
  "type: note",     // 1
  "---",            // 2  frontmatter close
  "body line",      // 3
  "```ts",          // 4  fence open (no indent)
  "const x = 1;",   // 5
  "```",            // 6  fence close
  "   ```",         // 7  fence open with 3-space indent
  "indented fence content", // 8
  "   ```",         // 9  fence close with indent
  "> quoted line",  // 10 blockquote
  "~~~~",           // 11 tilde fence open (4 chars)
  "tilde content",  // 12
  "~~~~",           // 13 tilde fence close
  "last line",      // 14
].join("\n");

describe("claims excludedLineFlags (boolean per line, 0-indexed)", () => {
  test("frontmatter, fences (incl. 0-3 space indent), tilde fences excluded", () => {
    const flags = excludedLineFlags(FIXTURE.split("\n"));
    // Adjust these expectations to the OBSERVED current behavior on first
    // run — then they are frozen. Document any surprise in the test body.
    expect(flags.length).toBe(15);
    expect(flags.slice(0, 3)).toEqual([true, true, true]);   // frontmatter
    expect(flags.slice(4, 7)).toEqual([true, true, true]);   // backtick fence
    expect(flags.slice(7, 10)).toEqual([true, true, true]);  // indented fence (claims allows 0-3 spaces)
    expect(flags[3]).toBe(false);                            // plain body
    expect(flags.slice(11, 14)).toEqual([true, true, true]); // tilde fence
    expect(flags[14]).toBe(false);
  });
});

describe("daily frontmatterLineRange / fencedCodeBlockLineRanges", () => {
  test("frontmatter range matches current contract", () => {
    expect(frontmatterLineRange(FIXTURE)).toEqual(
      // 1-indexed {start, end} per current implementation — verify on first
      // run and freeze the observed value.
      { start: 1, end: 3 },
    );
  });

  test("fence ranges: record whether indented fences are recognized", () => {
    const ranges = fencedCodeBlockLineRanges(FIXTURE);
    // The inventory says daily's regex differs from claims' on leading
    // indent. Whatever the observed ranges are on first run, freeze them
    // here with a comment naming the divergence.
    expect(ranges.length).toBeGreaterThanOrEqual(2);
  });

  test("unterminated fence extends to EOF", () => {
    const ranges = fencedCodeBlockLineRanges("a\n```\nb\nc");
    expect(ranges).toEqual([{ start: 2, end: 4 }]);
  });
});
```

**Important:** the literal expectations above are best-effort predictions. On first run, where an assertion disagrees with observed behavior, update the EXPECTATION to the observed value and add a one-line comment (e.g. `// daily does NOT recognize indented fences — divergence from claims, preserved`). The point of this task is to discover and freeze the truth, not to assert my guesses. Never "fix" the implementation in this task.

- [ ] **Step 2: Write the anchor-stability test**

```ts
// tests/core/anchor-id-stability.test.ts
//
// Golden anchor IDs. ^t…/^c… anchors are durable identity in committed user
// markdown — if any refactor changes these hashes, every task and claim in
// every vault gets re-identified. These literals are computed from the
// CURRENT implementation and must never change.

import { describe, expect, test } from "bun:test";

import { claimAnchorId } from "../../assets/extensions/dome.claims/processors/claims-shared";
import { taskAnchorId } from "../../assets/extensions/dome.daily/processors/daily-shared";

describe("anchor id stability", () => {
  test("taskAnchorId golden values", () => {
    const a = taskAnchorId({
      path: "wiki/dailies/2026-06-01.md",
      body: "Follow up with Maya about the platform review",
      occurrence: 0,
    });
    const b = taskAnchorId({
      path: "./wiki/dailies/2026-06-01.md",
      body: "Follow  up with  Maya about the platform review",
      occurrence: 0,
    });
    expect(a).toMatch(/^t[0-9a-f]{8}$/);
    // Path normalization + body whitespace collapse must keep these equal
    // (verify against current behavior on first run; if unequal, freeze the
    // observed values separately with a comment).
    expect(b).toBe(a);
    // GOLDEN: freeze the literal observed on first run:
    // expect(a).toBe("t????????");
  });

  test("claimAnchorId golden values", () => {
    const a = claimAnchorId({
      path: "wiki/entities/acme.md",
      key: "Headcount",
      occurrence: 0,
    });
    expect(a).toMatch(/^c[0-9a-f]{8}$/);
    // GOLDEN: freeze the literal observed on first run:
    // expect(a).toBe("c????????");
  });
});
```

On first run, replace the commented GOLDEN lines with real literals (run the test, read the values via a temporary `console.log` or failing `toBe("")`, freeze them, remove the temporary). Check `claimAnchorId`'s actual input shape first (`grep -n "claimAnchorId" assets/extensions/dome.claims/processors/claims-shared.ts`) and match it.

- [ ] **Step 3: Write the config-message characterization test**

```ts
// tests/core/config-path-messages.test.ts
//
// Pins the exact problem/error strings of the three config path validators.
// These strings surface in user-facing diagnostics; the stdlib extraction
// must reproduce them byte-for-byte.

import { describe, expect, test } from "bun:test";

import { coreMemoryPath } from "../../assets/extensions/dome.agent/lib/core-memory";
import { consolidationLedgerPath } from "../../assets/extensions/dome.agent/processors/consolidate";
import { dailyPathSettings } from "../../assets/extensions/dome.daily/processors/daily-shared";

describe("config path validator messages", () => {
  test("coreMemoryPath problems", () => {
    expect(coreMemoryPath({ core_path: 42 }).problem).toBe(
      "core_path must be a string",
    );
    expect(coreMemoryPath({ core_path: "notes/core.txt" }).problem).toBe(
      "core_path must be a non-empty .md path",
    );
    expect(coreMemoryPath({ core_path: "/abs/core.md" }).problem).toBe(
      "core_path must be a relative vault markdown path",
    );
    expect(coreMemoryPath({ core_path: "a/../core.md" }).problem).toBe(
      "core_path must be a relative vault markdown path",
    );
    expect(coreMemoryPath(undefined).problem).toBeNull();
  });

  test("consolidationLedgerPath problems", () => {
    expect(consolidationLedgerPath({ consolidation_ledger_path: 42 }).problem).toBe(
      "consolidation_ledger_path must be a string",
    );
    expect(
      consolidationLedgerPath({ consolidation_ledger_path: "/x.md" }).problem,
    ).toBe("consolidation_ledger_path must be a relative vault markdown path");
  });

  test("dailyPathSettings throws with exact messages", () => {
    expect(() => dailyPathSettings({ daily_path: 42 })).toThrow(
      "dome.daily config daily_path must be a string",
    );
    expect(() => dailyPathSettings({ daily_path: "notes/x.md" })).toThrow(
      "dome.daily config daily_path must contain exactly one {date} placeholder",
    );
    expect(() => dailyPathSettings({ daily_path: "/abs/{date}.md" })).toThrow(
      "dome.daily config daily_path must be a relative vault markdown path",
    );
    expect(dailyPathSettings({ daily_path: "notes/{date}.md" }).template).toBe(
      "notes/{date}.md",
    );
  });
});
```

Verify each return-shape field name against the real code (`problem` vs other names) and adjust to observed reality.

- [ ] **Step 4: Run all three, freeze observed values, verify green**

Run: `bun test tests/core/markdown-scan-characterization.test.ts tests/core/anchor-id-stability.test.ts tests/core/config-path-messages.test.ts`
Expected: PASS with all golden literals frozen (no remaining `t????????` placeholders, no commented-out goldens).

- [ ] **Step 5: Commit**

```bash
git add tests/core/
git commit -m "test: characterization fences for markdown scanning, anchor ids, and config-path messages"
```

Report in your summary: every place observed behavior differed from this plan's predictions (especially the daily fence-indent question), as a list of frozen divergences.

---

### Task 2: `src/core/markdown-scan.ts` — shared scanning primitives

**Files:**
- Create: `src/core/markdown-scan.ts`
- Modify: `assets/extensions/dome.daily/processors/daily-shared.ts` (delete the moved bodies; re-export from core)
- Modify: `assets/extensions/dome.claims/processors/claims-shared.ts` (consume the shared primitives via a thin adapter)

- [ ] **Step 1: Create the core module by MOVING the daily implementations verbatim**

```ts
// src/core/markdown-scan.ts
//
// Shared markdown region scanners for processor authors: frontmatter and
// fenced-code line ranges. Moved verbatim from dome.daily's daily-shared.ts;
// behavior is pinned by tests/core/markdown-scan-characterization.test.ts.
// The fence matcher takes an indent option because the claims and daily
// scanners historically diverged (claims tolerates 0-3 leading spaces per
// CommonMark; daily does not) — both behaviors are preserved, selected by
// the caller.

export type LineRange = { readonly start: number; readonly end: number };

export function frontmatterLineRange(content: string): LineRange | null {
  // <paste the daily-shared implementation body verbatim>
}

export function fencedCodeBlockLineRanges(
  content: string,
  opts?: { readonly allowIndentedFences?: boolean },
): ReadonlyArray<LineRange> {
  // <paste the daily-shared implementation body verbatim, with ONE change:
  //  the fence-open/close matcher uses
  //    opts?.allowIndentedFences ? /^[ ]{0,3}(`{3,}|~{3,})/ : <daily's exact current regex>
  //  Match the daily current behavior EXACTLY when the option is absent.>
}
```

Use the real bodies from `daily-shared.ts` (~lines 1904-1939) — copy, don't rewrite. If daily's current matcher operates on `trimStart()`ed lines or otherwise differs from the inventory's description, the CODE is the truth; the option only adds the claims variant.

- [ ] **Step 2: daily-shared consumes core**

In `daily-shared.ts`: delete the moved function bodies; add
```ts
import { fencedCodeBlockLineRanges, frontmatterLineRange } from "../../../../src/core/markdown-scan";
```
and re-export them (`export { fencedCodeBlockLineRanges, frontmatterLineRange };`) so existing importers and tests are untouched. Daily's call sites pass no options (preserving daily behavior).

- [ ] **Step 3: claims-shared consumes core via adapter**

In `claims-shared.ts`, reimplement `excludedLineFlags` as an adapter over the core scanners with `{ allowIndentedFences: true }`, deriving the boolean array from the returned ranges, and keeping every claims-local exclusion that is NOT part of the shared scan (blockquote skip, anchor-line skip) exactly where it currently happens. The function's signature and observable output must not change.

- [ ] **Step 4: Verify**

Run: `bun test tests/core/markdown-scan-characterization.test.ts tests/extensions/daily-shared.test.ts tests/processors/claims-grammar.test.ts tests/processors/claims-stamp.test.ts`
Expected: PASS, zero assertion changes.
Run: `bun test tests/integration/processor-purity.test.ts` → PASS (core module is pure).

- [ ] **Step 5: Commit**

```bash
git add src/core/markdown-scan.ts assets/extensions/dome.daily assets/extensions/dome.claims
git commit -m "refactor(core): shared markdown-scan primitives; claims/daily consume with preserved divergences"
```

---

### Task 3: anchor-id helper in `src/core/block-anchor.ts`

**Files:**
- Modify: `src/core/block-anchor.ts` (add one function)
- Modify: `assets/extensions/dome.daily/processors/daily-shared.ts` (`taskAnchorId` delegates)
- Modify: `assets/extensions/dome.claims/processors/claims-shared.ts` (`claimAnchorId` delegates)

- [ ] **Step 1: Read both current implementations and `src/core/block-anchor.ts`**

Confirm both do `createHash("sha256").update(JSON.stringify([...parts])).digest("hex").slice(0, 8)` with a one-char prefix. If either differs structurally, STOP and report (the shared helper must reproduce both exactly or not exist).

- [ ] **Step 2: Add the helper**

```ts
// in src/core/block-anchor.ts, following the file's existing style:

/**
 * Deterministic 8-hex-char content anchor id with a namespace prefix.
 * The hash input is JSON.stringify(parts) — callers own normalization of
 * the parts (path normalization, body collapsing); this helper owns only
 * the hash shape. Pinned by tests/core/anchor-id-stability.test.ts:
 * changing this changes every ^t…/^c… anchor in every committed vault.
 */
export function contentAnchorId(
  prefix: string,
  parts: ReadonlyArray<string | number>,
): string {
  return `${prefix}${createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 8)}`;
}
```

(Import `createHash` from `node:crypto` if the file doesn't already.)

- [ ] **Step 3: Delegate both call sites**

`taskAnchorId` body → `return contentAnchorId("t", [normalizeSourcePath(input.path), normalizeOpenLoopBody(input.body), input.occurrence]);` — preserving the EXACT same parts expressions currently passed to JSON.stringify. Same for `claimAnchorId` with prefix `c` and its current parts. Signatures unchanged.

- [ ] **Step 4: Verify golden stability**

Run: `bun test tests/core/anchor-id-stability.test.ts tests/processors/claims-stamp.test.ts tests/extensions/daily-shared.test.ts`
Expected: PASS — the golden literals from Task 1 still match exactly.

- [ ] **Step 5: Commit**

```bash
git add src/core/block-anchor.ts assets/extensions/dome.daily assets/extensions/dome.claims
git commit -m "refactor(core): contentAnchorId helper; task/claim anchors delegate (golden-pinned)"
```

---

### Task 4: `src/core/config-path.ts` — shared path-validation gauntlet

**Files:**
- Create: `src/core/config-path.ts`
- Modify: `assets/extensions/dome.agent/lib/core-memory.ts`
- Modify: `assets/extensions/dome.agent/processors/consolidate.ts`
- Modify: `assets/extensions/dome.daily/processors/daily-shared.ts` (`validateDailyPathTemplate` keeps its `{date}` rule, delegates the common checks)

- [ ] **Step 1: Create the core module**

```ts
// src/core/config-path.ts
//
// The relative-vault-markdown-path validation gauntlet shared by extension
// config readers (core_path, consolidation_ledger_path, daily_path).
// Message strings are pinned byte-for-byte by
// tests/core/config-path-messages.test.ts — the `field` parameter
// reproduces each caller's historical wording.

export type ConfigPathResolution = {
  readonly path: string | null;
  readonly problem: string | null;
};

export function validateRelativeMarkdownPath(
  raw: unknown,
  field: string,
): ConfigPathResolution {
  if (typeof raw !== "string") {
    return { path: null, problem: `${field} must be a string` };
  }
  if (raw.trim() !== raw || raw.length === 0 || !raw.endsWith(".md")) {
    return { path: null, problem: `${field} must be a non-empty .md path` };
  }
  if (
    raw.startsWith("/") ||
    raw.includes("\\") ||
    raw
      .split("/")
      .some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    return {
      path: null,
      problem: `${field} must be a relative vault markdown path`,
    };
  }
  return { path: raw, problem: null };
}
```

- [ ] **Step 2: Delegate the three callers**

- `coreMemoryPath`: keep its signature, default handling (`raw === undefined → DEFAULT_CORE_PATH`), and return type; the validation chain becomes one call to `validateRelativeMarkdownPath(raw, "core_path")` mapped into its existing `{path, problem}`/fallback shape.
- `consolidationLedgerPath`: identical pattern with field `"consolidation_ledger_path"`.
- `validateDailyPathTemplate`: keep the `{date}` placeholder check and the throw-on-problem behavior; for the common checks, run `validateRelativeMarkdownPath(sample, "dome.daily config daily_path")` on the `{date}`-substituted sample and throw its `problem` — BUT verify the produced messages byte-match the current ones (Task 1's test enforces this; note the daily variant says "must produce a .md file" for the .md check, which differs from the shared "must be a non-empty .md path" — if so, keep that specific check daily-local and delegate only the checks whose messages match exactly. The characterization test is the arbiter).

- [ ] **Step 3: Verify**

Run: `bun test tests/core/config-path-messages.test.ts tests/extensions/dome.agent/core-memory.test.ts tests/extensions/daily-shared.test.ts tests/extensions/dome.agent`
Expected: PASS with zero assertion changes.

- [ ] **Step 4: Commit**

```bash
git add src/core/config-path.ts assets/extensions/dome.agent assets/extensions/dome.daily
git commit -m "refactor(core): shared relative-markdown-path config validator; three callers delegate (messages pinned)"
```

---

### Task 5: Decompose `daily-shared.ts` behind a barrel

**Files:**
- Create: `assets/extensions/dome.daily/processors/daily-types.ts` (block markers + type defs; inventory region (a))
- Create: `assets/extensions/dome.daily/processors/daily-paths.ts` (region (b): localDateParts, previousLocalDate, formatDate, dailyPath, dailyLink, parseDailyPath, dailyPathSettings + validateDailyPathTemplate)
- Create: `assets/extensions/dome.daily/processors/action-extraction.ts` (region (c) + (i): openTasksFromMarkdown, actionItemsFromMarkdown, settledActionItemsFromMarkdown, ambiguousFollowupsFromMarkdown, stampTaskAnchors, normalizeTaskSyntax, taskAnchorId, isObsidianTasksDashboard, actionExtractionLineRanges, dailyGeneratedBlockLineRanges + their internal helpers: openTaskFromLine, directiveActionItemFromLine, normalizeOpenLoopBody, normalizeSourcePath, semanticActionBody, looksLikeAmbiguousFollowup, sourceBackedCheckboxFromLine, lineIsInsideRanges, lineNumberAtOffset)
- Create: `assets/extensions/dome.daily/processors/open-loop-surface.ts` (region (d) + reconciliation (h') + replaceOpenLoopSurfaceSection: the 11 region-(d) exports, reconcileSettledOpenLoops, compareOpenLoopSources)
- Create: `assets/extensions/dome.daily/processors/daily-scaffold.ts` (regions (g)+(h)+(e)+legacy-section removal: renderDailySkeleton, closeScaffoldSection, ensureCloseScaffoldSection, previousDailyDigest, yesterdayFallbackSection, ensureYesterdayFallbackSection, closeDigestFromDailyContent, carriedForwardSection, replaceCarriedForwardSection, removeLegacyStartContextSection, cleanContextLine)
- Create: `assets/extensions/dome.daily/processors/captured-block.ts` (region (f): CAPTURED_LINE_MAX_CHARS, CAPTURED_APPEND_MAX_LINES, isCapturedTaskLine, appendCapturedTaskLines, isValidCapturedTasksWrite, repairCapturedTodayHeadings)
- Rewrite: `assets/extensions/dome.daily/processors/daily-shared.ts` → a pure re-export barrel
- NO consumer import changes (every importer across dome.daily, dome.search, dome.agent, and tests keeps importing from `daily-shared`)

- [ ] **Step 1: Confirm the move inventory**

Run: `grep -n "^export" assets/extensions/dome.daily/processors/daily-shared.ts | wc -l` and capture the full export list (`grep -n "^export"` output). Every exported symbol must appear in exactly one new module AND in the barrel. Internal (non-exported) helpers move to the module of their primary caller; if two modules need one internal helper, it goes to the lower-level module (daily-types < daily-paths < action-extraction < open-loop-surface < {daily-scaffold, captured-block}) and is exported from there (module-level export is fine; the barrel only re-exports what daily-shared exported before).

- [ ] **Step 2: Execute the split bottom-up**

Order: daily-types → daily-paths → action-extraction → open-loop-surface → daily-scaffold + captured-block. For each module: move code verbatim (cut-paste, preserving comments), add the imports it needs (from `src/core/` and from the lower daily modules), and keep `daily-shared.ts` compiling at every point by importing+re-exporting from the new module as you go. Allowed import direction between the new modules is exactly the order above (no cycles); if a genuine cycle appears, STOP and report rather than restructuring code bodies.

- [ ] **Step 3: Finish the barrel**

`daily-shared.ts` ends as ONLY re-exports:
```ts
// daily-shared.ts — compatibility barrel for the dome.daily helper modules.
// New code should import from the specific module; existing importers and
// the cross-bundle consumers (dome.search, dome.agent) resolve through here
// unchanged. No logic lives in this file.
export * from "./daily-types";
export * from "./daily-paths";
export * from "./action-extraction";
export * from "./open-loop-surface";
export * from "./daily-scaffold";
export * from "./captured-block";
```
If `export *` causes name collisions or re-export of symbols that were previously module-private, switch to explicit named re-exports matching the ORIGINAL export list exactly (preferred if in doubt — the barrel's public surface must equal the old file's public surface, no more, no less).

- [ ] **Step 4: Verify hard**

Run: `bunx tsc --noEmit` (or the repo typecheck script) → clean.
Run: `bun test tests/extensions tests/processors tests/core` → PASS, zero assertion changes.
Run: `bun test tests/harness` → PASS (the daily/claims/search scenarios exercise the moved code end-to-end through real adoption).
Run: `git diff --stat` sanity: `daily-shared.ts` should shrink to ~30 lines; the six new modules should sum to roughly the original size (verbatim moves).

- [ ] **Step 5: Commit**

```bash
git add assets/extensions/dome.daily
git commit -m "refactor(dome.daily): decompose daily-shared into six focused modules behind a compatibility barrel"
```

---

### Task 6: Stage `export-context.ts`

**Files:**
- Create: `assets/extensions/dome.search/processors/packet-render.ts`
- Modify: `assets/extensions/dome.search/processors/export-context.ts`

- [ ] **Step 1: Move the render layer**

Move `renderMarkdown` (~lines 770-877), `renderOverview` (~878-946), and the render-only helpers they exclusively use, verbatim, into `packet-render.ts` (exported). `export-context.ts` imports them. If a helper is used by both render and non-render code, it stays in `export-context.ts` and `packet-render.ts` imports it — no body changes.

- [ ] **Step 2: Stage the run() body**

Within `export-context.ts`, restructure `run()` into sequential named stage functions (no logic changes — lift the existing inline blocks into functions with explicit parameters):

```ts
async run(ctx) {
  const input = parseExportInput(ctx.input);
  const collected = await collectCandidates(ctx, input);   // search fetch + recall signals + link expansion (current lines ~71-164)
  const ranked = rankCandidates(collected, input);          // scoring + fusion + ordering (~165-180)
  const overview = buildOverview(ranked, collected, input); // existing buildOverview, possibly already named
  return [viewEffectFor(renderMarkdown(ranked, overview, input), ...)]; // existing render + effect construction
}
```

Match the REAL current variable flow — the stage signatures above are directional; derive exact parameters from what the inline blocks actually consume/produce. Each stage function gets a one-line comment naming its job. Do not reorder computation, do not dedupe "redundant" work, do not rename existing exported symbols.

- [ ] **Step 3: Verify**

Run: `bun test tests/extensions tests/harness/scenarios/cli-surface` → PASS (export-context scenario + any query/search tests pin the packet output).
Run: `bunx tsc --noEmit` → clean.

- [ ] **Step 4: Commit**

```bash
git add assets/extensions/dome.search
git commit -m "refactor(dome.search): split packet rendering from export-context; stage run() into named phases"
```

---

### Final gate

- [ ] Run the FULL suite from clean state: `bun test` → expect ~2068+ pass, 0 fail (plus the new characterization tests).
- [ ] Run `git diff main --stat` and confirm: no changes outside `src/core/`, `assets/extensions/{dome.daily,dome.claims,dome.agent,dome.search}`, `tests/core/`, and this plan file.
- [ ] Confirm zero changes to any `.snap` file and zero changes to `tests/extensions/*.test.ts` assertions (import-path updates only, if any).
- [ ] Dispatch final whole-branch review, then `--no-ff` merge into main per repo convention.

---

## Out of scope (do NOT do on this branch)

- Fixing any divergence the characterization tests freeze (e.g. daily's fence-indent behavior, stampTaskAnchors' missing dedup) — report them; changing them re-identifies committed content.
- Migrating consumers off the `daily-shared` barrel to direct module imports.
- Review items 6 and 7 (markTerminal/adopt.ts; CLI test split / status-check-doctor tiering).
- The recovery-effect taxonomy merge.
- Updating docs/wiki specs for the new module layout (one follow-up line in `docs/wiki/specs/processors.md` or the sdk-surface bundle section MAY be added in the final task if a reviewer asks; otherwise leave docs untouched — the substrate documents behavior, not file layout).
