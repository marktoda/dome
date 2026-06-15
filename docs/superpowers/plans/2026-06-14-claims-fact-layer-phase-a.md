# Claims Fact Layer — Phase A (Retrieval) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make existing `dome.claims.claim` facts a first-class, human/agent-legible signal in recall — decoded (not raw JSON), ranked high enough not to be crowded out, and surfaced as a dedicated dated "Current facts" section in `export-context` and `query`.

**Architecture:** A new shared decoder module (`claims-fact.ts`) parses the claim fact's JSON object into `{key, value, asOf}`. The existing display-label, fact-ordering, overview-build, and ranking paths in `dome.search` consume it. No schema change, no new effect kind, no model — pure view-phase rendering over facts the indexer already emits. This is the plumbing Phases B (authoring) and C (health) reuse.

**Tech Stack:** TypeScript on Bun; `dome.search` extension processors under `assets/extensions/dome.search/processors/`; `bun test`. All `assets/` files use relative `../../../../src/` imports and are excluded from the root tsconfig (typecheck via `bunx tsc --noEmit -p tsconfig.bundles.json`).

**Design source:** `docs/cohesive/brainstorms/2026-06-14-claims-fact-layer.md` (Link 2 — Retrieval).

**Scope note:** Phase A is retrieval over claims that already exist. The brief-weaving bullet from the design's Link 2 is intentionally deferred to Phase B, because the brief is a model agent whose value depends on a populated claim layer (which Phase B creates). Ranking is included here as a modest additive signal; query-term-to-claim snippet matching is already covered by the FTS body channel (claim lines are indexed prose).

---

### Task 1: Shared claim-fact decoder + legible label

**Files:**
- Create: `assets/extensions/dome.search/processors/claims-fact.ts`
- Modify: `assets/extensions/dome.search/processors/labels.ts` (the `searchFactObjectLabel` function, lines 10-22)
- Test: `tests/extensions/search-claims-label.test.ts`

The claim fact object is the JSON produced by `dome.claims.index`'s `claimFactValue`: `JSON.stringify({ key, value, ...(asOf ? { asOf } : {}) })` (see `assets/extensions/dome.claims/processors/claim-index.ts:21-27`). Today `searchFactObjectLabel` returns that raw JSON string for claim facts.

- [ ] **Step 1: Write the failing test**

Create `tests/extensions/search-claims-label.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";

import {
  CLAIM_PREDICATE,
  parseClaimFact,
} from "../../assets/extensions/dome.search/processors/claims-fact";
import { searchFactObjectLabel } from "../../assets/extensions/dome.search/processors/labels";
import type { FactEffect } from "../../src/core/effect";

function claimFact(object: string): FactEffect {
  return {
    kind: "fact",
    subject: { kind: "page", path: "wiki/projects/atlas.md" },
    predicate: CLAIM_PREDICATE,
    object: { kind: "string", value: object },
    assertion: "extracted",
    sourceRefs: [],
  } as FactEffect;
}

describe("parseClaimFact", () => {
  test("decodes a claim fact with an as-of date", () => {
    const parsed = parseClaimFact(
      claimFact(JSON.stringify({ key: "Status", value: "in design review", asOf: "2026-06-12" })),
    );
    expect(parsed).toEqual({ key: "Status", value: "in design review", asOf: "2026-06-12" });
  });

  test("decodes a claim fact without an as-of date", () => {
    const parsed = parseClaimFact(
      claimFact(JSON.stringify({ key: "Owner", value: "[[danny]]" })),
    );
    expect(parsed).toEqual({ key: "Owner", value: "[[danny]]", asOf: null });
  });

  test("returns null for a non-claim predicate", () => {
    const fact = { ...claimFact("{}"), predicate: "dome.graph.links_to" } as FactEffect;
    expect(parseClaimFact(fact)).toBeNull();
  });

  test("returns null for malformed JSON (defensive, no throw)", () => {
    expect(parseClaimFact(claimFact("not json"))).toBeNull();
    expect(parseClaimFact(claimFact(JSON.stringify({ key: "x" })))).toBeNull(); // missing value
  });
});

describe("searchFactObjectLabel for claims", () => {
  test("renders Key: value (as of date)", () => {
    expect(
      searchFactObjectLabel(
        claimFact(JSON.stringify({ key: "Status", value: "in design review", asOf: "2026-06-12" })),
      ),
    ).toBe("Status: in design review (as of 2026-06-12)");
  });

  test("renders Key: value when no as-of", () => {
    expect(
      searchFactObjectLabel(claimFact(JSON.stringify({ key: "Owner", value: "[[danny]]" }))),
    ).toBe("Owner: [[danny]]");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/extensions/search-claims-label.test.ts`
Expected: FAIL — module `claims-fact` not found / `parseClaimFact` undefined.

- [ ] **Step 3: Create the decoder module**

Create `assets/extensions/dome.search/processors/claims-fact.ts`:

```typescript
// Shared decoder for dome.claims.claim facts in dome.search view processors.
//
// dome.claims.index stores each claim's object as the canonical JSON string
// `{key, value, asOf?}` (see assets/extensions/dome.claims/processors/
// claim-index.ts). This module is the one place that decodes that blob, so
// the label, ordering, overview, and ranking paths all agree on the shape.

import type { FactEffect } from "../../../../src/core/effect";

export const CLAIM_PREDICATE = "dome.claims.claim";

export type ClaimFact = {
  readonly key: string;
  readonly value: string;
  readonly asOf: string | null;
};

/** Decode a `dome.claims.claim` fact, or null if it is not one / is malformed. */
export function parseClaimFact(fact: FactEffect): ClaimFact | null {
  if (fact.predicate !== CLAIM_PREDICATE || fact.object.kind !== "string") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fact.object.value);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.key !== "string" || typeof record.value !== "string") {
    return null;
  }
  return Object.freeze({
    key: record.key,
    value: record.value,
    asOf: typeof record.asOf === "string" ? record.asOf : null,
  });
}

/** Human-legible one-line label: `Key: value (as of YYYY-MM-DD)`. */
export function claimLabel(claim: ClaimFact): string {
  return claim.asOf !== null
    ? `${claim.key}: ${claim.value} (as of ${claim.asOf})`
    : `${claim.key}: ${claim.value}`;
}

/** True when the fact is a decodable claim fact. */
export function isClaimFact(fact: FactEffect): boolean {
  return parseClaimFact(fact) !== null;
}
```

- [ ] **Step 4: Wire the label**

In `assets/extensions/dome.search/processors/labels.ts`, add the import at the top and a claim branch at the start of `searchFactObjectLabel` (before the existing `objectLabel(fact.object)` call):

```typescript
import { claimLabel, parseClaimFact } from "./claims-fact";

export function searchFactObjectLabel(fact: FactEffect): string {
  const claim = parseClaimFact(fact);
  if (claim !== null) return claimLabel(claim);
  const raw = objectLabel(fact.object);
  // ...existing open_task/followup handling unchanged...
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/extensions/search-claims-label.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Typecheck + commit**

Run: `bunx tsc --noEmit -p tsconfig.bundles.json` → clean.

```bash
git add assets/extensions/dome.search/processors/claims-fact.ts assets/extensions/dome.search/processors/labels.ts tests/extensions/search-claims-label.test.ts
git commit -m "feat(dome.search): decode dome.claims.claim facts into legible labels"
```

---

### Task 2: Rank claims high in fact ordering (query + export-context)

**Files:**
- Modify: `assets/extensions/dome.search/processors/query.ts` (the `factPriority` function, lines 367-372)
- Test: `tests/extensions/search-query-dedupe.test.ts` (add a describe block)

Today `factPriority` returns: open-loop 0, decision 1, graph 3, everything-else 2. Claim facts fall into "everything-else" (2) and get sorted after the per-match cap (8 rows), so they can be crowded out. Claims should rank just below decisions.

- [ ] **Step 1: Write the failing test**

Add to `tests/extensions/search-query-dedupe.test.ts` (import `factPriority` if exported; if it is not exported, export it from query.ts as part of this task — it is module-private today, so add `export` to its declaration):

```typescript
import { factPriority } from "../../assets/extensions/dome.search/processors/query";
import { CLAIM_PREDICATE } from "../../assets/extensions/dome.search/processors/claims-fact";
import type { FactEffect } from "../../src/core/effect";

function fact(predicate: string, value = "{}"): FactEffect {
  return {
    kind: "fact",
    subject: { kind: "page", path: "p.md" },
    predicate,
    object: { kind: "string", value },
    assertion: "extracted",
    sourceRefs: [],
  } as FactEffect;
}

describe("factPriority — claims", () => {
  test("claims rank above generic facts and graph facts", () => {
    const claim = factPriority(
      fact(CLAIM_PREDICATE, JSON.stringify({ key: "Status", value: "x" })),
    );
    expect(claim).toBeLessThan(factPriority(fact("dome.page.description")));
    expect(claim).toBeLessThan(factPriority(fact("dome.graph.links_to")));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/extensions/search-query-dedupe.test.ts`
Expected: FAIL — `factPriority` not exported, or claim priority equals generic (2) so the `toBeLessThan` assertions fail.

- [ ] **Step 3: Implement**

In `query.ts`, add the import and a claim branch to `factPriority`, and `export` the function:

```typescript
import { isClaimFact } from "./claims-fact";

export function factPriority(fact: FactEffect): number {
  if (isSearchOpenLoopFact(fact)) return 0;
  if (isSearchDecisionFact(fact)) return 1;
  if (isClaimFact(fact)) return 1; // load-bearing; tie with decisions, break by predicate/label
  if (isGraphFact(fact)) return 3;
  return 2;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/extensions/search-query-dedupe.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `bunx tsc --noEmit -p tsconfig.bundles.json` → clean.

```bash
git add assets/extensions/dome.search/processors/query.ts tests/extensions/search-query-dedupe.test.ts
git commit -m "feat(dome.search): rank claim facts high so they are not crowded out of query results"
```

---

### Task 3: Dedicated "Current facts" section in export-context

**Files:**
- Modify: `assets/extensions/dome.search/processors/export-context.ts` (add a `claims` bucket to `ContextOverview` at lines 192-199; populate it in `buildOverview`; render it in the markdown builder)
- Test: `tests/harness/scenarios/cli-surface/export-context.scenario.test.ts` (add a scenario assertion) and/or a focused unit test if `buildOverview` is exported.

`ContextOverview` (lines 192-199) has `readFirst / openLoops / decisions / unresolvedQuestions / diagnostics / recallSignals`. Add a parallel `claims` bucket so an agent reading the packet sees the current dated facts up front, deduped to one row per (path, key) at the latest as-of.

- [ ] **Step 1: Read the file region first**

Read `assets/extensions/dome.search/processors/export-context.ts` around: the `ContextOverview` type (192-199), the `ContextDecision` type and how `decisions` is built in `buildOverview`, the `factsByPath` map construction (≈369-377), and the markdown render section that prints the overview. Mirror the `decisions` bucket pattern exactly for `claims`.

- [ ] **Step 2: Write the failing scenario assertion**

In `tests/harness/scenarios/cli-surface/export-context.scenario.test.ts`, extend (or add) a scenario whose fixture vault has a page with two claim lines, e.g.:

```
wiki/projects/atlas.md:
  ---
  type: project
  ---
  - **Status:** in design review *(as of 2026-06-12)* ^cAAAA
  - **Owner:** [[danny]] ^cBBBB
```

Run `export-context` for "atlas" and assert the rendered markdown contains a "Current facts" heading and the line `Status: in design review (as of 2026-06-12)`, and that the JSON `overview.claims` array contains `{ path: "wiki/projects/atlas.md", key: "Status", value: "in design review", asOf: "2026-06-12" }`. (Follow the existing scenario's harness setup and assertion style in this same file.)

- [ ] **Step 3: Run to verify it fails**

Run: `bun test tests/harness/scenarios/cli-surface/export-context.scenario.test.ts`
Expected: FAIL — no "Current facts" section / `overview.claims` undefined.

- [ ] **Step 4: Implement**

Add the type, build, and render:

```typescript
// near ContextOverview
import { type ClaimFact, parseClaimFact } from "./claims-fact";

type ContextClaim = {
  readonly path: string;
  readonly key: string;
  readonly value: string;
  readonly asOf: string | null;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};
// add to ContextOverview: readonly claims: ReadonlyArray<ContextClaim>;
```

In `buildOverview`, after the `decisions` bucket is built, collect claim facts from the same fact set used for decisions (iterate the page-subject facts, `parseClaimFact` each, keep non-null), dedupe to one row per `(path, normalized key)` keeping the latest `asOf` (lexicographic max on the ISO date; null sorts before any date), order by path then key, and cap with the same limit pattern the other overview buckets use. Render under a `## Current facts` heading in the markdown builder, one line each: `- {claimLabel} — {path}`.

- [ ] **Step 5: Run to verify it passes**

Run: `bun test tests/harness/scenarios/cli-surface/export-context.scenario.test.ts`
Expected: PASS.

- [ ] **Step 6: Full search-suite regression + typecheck + commit**

Run: `bun test $(find tests -path "*search*" -name "*.test.ts"; find tests -iname "*export-context*" -name "*.test.ts")` → 0 fail.
Run: `bunx tsc --noEmit -p tsconfig.bundles.json` → clean.

```bash
git add assets/extensions/dome.search/processors/export-context.ts tests/harness/scenarios/cli-surface/export-context.scenario.test.ts
git commit -m "feat(dome.search): surface a Current facts (claims) section in export-context"
```

---

### Task 4: Modest claims ranking signal

**Files:**
- Modify: `assets/extensions/dome.search/processors/ranking.ts` (the per-page signal composition; the predicate-set guards near lines 79-86)
- Test: `tests/extensions/search-ranking.test.ts`

A page carrying claims is a consolidated, load-bearing page; give it a small additive ranking signal, mirroring the existing decision signal (counted, capped) — NOT a new RRF channel (claim line text is already in the FTS body, so term-matching is covered).

- [ ] **Step 1: Read the signal region first**

Read `ranking.ts` around lines 79-234: the `SEARCH_*` predicate guards (`isSearchOpenLoopFact`, `isSearchDecisionFact`) and the signal composition in `rankSearchCandidate` where decision facts contribute weight (find the `decision` signal: weight per item, max cap). Mirror it for claims with a smaller cap.

- [ ] **Step 2: Write the failing test**

In `tests/extensions/search-ranking.test.ts`, add a test: two otherwise-identical candidates, one with N `dome.claims.claim` facts and one with none; assert the claim-bearing candidate's score is strictly higher. Use the existing test's candidate-construction helpers in that file.

- [ ] **Step 3: Run to verify it fails**

Run: `bun test tests/extensions/search-ranking.test.ts`
Expected: FAIL — scores equal (claims contribute nothing today).

- [ ] **Step 4: Implement**

Add a claims signal mirroring the decision signal: count claim facts per page (`parseClaimFact` non-null), contribute `weight × min(count, cap)` with a conservative weight and a low cap (e.g. weight 1, cap 3 — claims should nudge, never dominate FTS relevance). Import `isClaimFact` from `./claims-fact`. Keep it additive in the same signals array decisions use.

- [ ] **Step 5: Run to verify it passes (and existing ranking tests still pass)**

Run: `bun test tests/extensions/search-ranking.test.ts`
Expected: PASS, including all pre-existing ranking tests (the signal is additive and small; if any existing ordering test breaks, the weight/cap is too high — lower it rather than editing the assertion).

- [ ] **Step 6: Typecheck + commit**

Run: `bunx tsc --noEmit -p tsconfig.bundles.json` → clean.

```bash
git add assets/extensions/dome.search/processors/ranking.ts tests/extensions/search-ranking.test.ts
git commit -m "feat(dome.search): add a modest claim-bearing-page ranking signal"
```

---

### Task 5: Full-suite gate

- [ ] **Step 1: Run the whole suite**

Run: `bun test`
Expected: all pass, 0 fail (baseline is 2537 pass; this plan adds tests, so the count rises). If any pre-existing test regressed, fix the cause — do not edit the assertion to match.

- [ ] **Step 2: Full typecheck**

Run: `bunx tsc --noEmit` and `bunx tsc --noEmit -p tsconfig.bundles.json` → both clean.

- [ ] **Step 3: No commit** (each task already committed). Report the green suite.

---

## Self-review notes (author)

- **Spec coverage (Link 2):** decode/label = Task 1; not-crowded-out = Task 2; "Current facts" section in export-context = Task 3; ranking = Task 4; query already renders via the shared label (Task 1) + priority (Task 2). Brief-weaving is explicitly deferred to Phase B (stated in Scope note) — the one Link-2 bullet not in this plan, by design.
- **No placeholders:** Task 1 has complete code; Tasks 3-4 require reading a large file first (steps say so explicitly) and give the exact pattern to mirror plus concrete test assertions — the "read region first" step is a deliberate de-risking, not a TODO.
- **Type consistency:** `CLAIM_PREDICATE`, `parseClaimFact`, `claimLabel`, `isClaimFact`, `ClaimFact` are defined once in `claims-fact.ts` (Task 1) and imported by Tasks 2-4. `factPriority` is exported in Task 2 and used by its test.
