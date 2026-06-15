# Claims Fact Layer — Phase B (Authoring + Render) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the claim layer fill itself as pages grow — the nightly sweep agent mints/maintains claim lines for load-bearing facts, and a deterministic processor compiles a `## Current facts` digest block at the head of claim-rich pages.

**Architecture:** Two halves. (1) **Render** — a new deterministic garden processor `dome.claims.render-facts` parses a page's own claim lines (via the existing `claimsFromMarkdown`) and splices a generated `## Current facts` block into the page, using the sanctioned `src/core/generated-block.ts` grammar (the `dome.markdown.render-index` precedent). The claim parser is taught to ignore generated-block regions so the digest never re-feeds the claim index. (2) **Authoring** — the `dome.agent.sweep` charter gains a rule to promote durable, lookup-worthy facts to claim lines (mint-if-new, update-in-place-if-exists), within its existing `patch.auto` write boundary.

**Tech Stack:** TypeScript on Bun; extensions under `assets/extensions/`; `bun test`; typecheck via `bunx tsc --noEmit` (root, includes tests) AND `bunx tsc --noEmit -p tsconfig.bundles.json`. BOTH must be clean.

**Design source:** `docs/cohesive/brainstorms/2026-06-14-claims-fact-layer.md` (Links 1 and 1.5). Phase A (retrieval) is already merged.

**Scope:** Sweep authoring + the render processor. Per the design's Deferred list, `consolidate` promoting *existing scattered prose* into claims is a separate follow-on and is NOT in this plan. Phase C (health: staleness probe + `dome explain`) is its own plan.

**Key constraints (read before starting):**
- Garden processors CANNOT read the projection — `render-facts` re-parses the page content from the adopted snapshot (the `dome.agent.active-projects` / `dome.markdown.render-index` constraint).
- The render block is **presentational** (no `**Key:**` claim grammar) AND the claim parser excludes generated-block ranges — two independent guards so the digest is never indexed as claims.
- `MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS` stays intact: the sweep agent writes markdown; the deterministic indexer extracts facts. Minting claims is ordinary markdown authoring within the sweep's `patch.auto` glob.
- `NO_ACCRETING_REGISTRIES`: the digest is a deterministic whole-block rewrite, never an append.

---

### Task 1: Claim parser ignores generated-block regions

**Files:**
- Modify: `assets/extensions/dome.claims/processors/claims-shared.ts` (the `excludedLineFlags` helper used by `claimsFromMarkdown`)
- Test: `tests/processors/claims-grammar.test.ts`

`claimsFromMarkdown` already excludes frontmatter, code fences, and blockquotes via `excludedLineFlags`. Add generated-block exclusion so any `**Key:**`-shaped line inside a `dome.*` generated block (e.g. a future `## Current facts` digest) is never parsed as a claim. This makes the render in Task 2 safe by construction even if its format changes.

- [ ] **Step 1 — Read** `claims-shared.ts` (`excludedLineFlags`, `claimsFromMarkdown`) and `src/core/generated-block.ts` (`findAllGeneratedBlocks`, `blankGeneratedBlocks`). Note `blankGeneratedBlocks(content, owner, block)` blanks marker+body lines preserving line count — but it takes a specific (owner, block). We need to exclude ANY dome generated block. Use `findAllGeneratedBlocks` is per-(owner,block) too. Simplest robust approach: exclude lines that fall within ANY line-anchored generated-block marker pair regardless of owner/block. Implement a local line scan for marker pairs using the same line-anchored rule, OR — preferred — detect the dome marker comment lines and the lines between a `:start`/`:end` pair. Since `generated-block.ts` only exposes per-(owner,block) scans, add the exclusion in `claims-shared.ts` with a small local scanner that flags lines between any `<!-- dome…:start -->` and the matching `<!-- …:end -->` (line-anchored, trimmed-equality), mirroring `generated-block.ts`'s `isMarkerLine` discipline. Keep it pure/local (claims-shared is a zero-IO string module).

- [ ] **Step 2 — Write the failing test.** Add to `tests/processors/claims-grammar.test.ts`:

```typescript
test("claim lines inside a generated block are not parsed as claims", () => {
  const content = [
    "# Atlas",
    "",
    "<!-- dome.claims:current-facts:start -->",
    "- **Status:** in design review *(as of 2026-06-12)* ^cAAAA",
    "<!-- dome.claims:current-facts:end -->",
    "",
    "- **Owner:** [[danny]] ^cBBBB",
  ].join("\n");
  const claims = claimsFromMarkdown(content);
  // Only the Owner line outside the block is a claim.
  expect(claims.map((c) => c.key)).toEqual(["Owner"]);
});
```
(Match the file's existing import of `claimsFromMarkdown`.)

- [ ] **Step 3 — Run, verify FAIL** (`bun test tests/processors/claims-grammar.test.ts`): both Status and Owner returned.

- [ ] **Step 4 — Implement** the generated-block exclusion in `excludedLineFlags`: scan lines; when a trimmed line matches `<!-- dome<owner-chars>:<block>:start -->` (use a regex anchored to the whole trimmed line, e.g. `/^<!--\s*dome[.\w]*:[\w-]+:start\s*-->$/`), mark lines from the start marker through the matching `:end` marker (regex `/^<!--\s*dome[.\w]*:[\w-]+:end\s*-->$/`) inclusive as excluded. Unterminated start → exclude to EOF (consistent with the frontmatter dialect already there). Keep it simple and line-anchored.

- [ ] **Step 5 — Run, verify PASS.** Also run the full claims grammar/index/stamp suite: `bun test tests/processors/claims-grammar.test.ts tests/processors/claims-index.test.ts tests/processors/claims-stamp.test.ts` → 0 fail.

- [ ] **Step 6 — Typecheck + commit.** `bunx tsc --noEmit -p tsconfig.bundles.json` clean.
```bash
git add assets/extensions/dome.claims/processors/claims-shared.ts tests/processors/claims-grammar.test.ts
git commit -m "feat(dome.claims): claim parser ignores generated-block regions"
```

---

### Task 2: `render-facts` — pure block render + processor

**Files:**
- Create: `assets/extensions/dome.claims/processors/render-facts.ts`
- Test: `tests/extensions/dome.claims-render-facts.test.ts`

A deterministic garden processor. For each changed `.md` page under `wiki/**` / `notes/*`, parse its claim lines (`claimsFromMarkdown`); if the count ≥ threshold (config `current_facts_min_claims`, default 3), render a `## Current facts` generated block (owner `dome.claims`, block `current-facts`) and splice it into the page after the frontmatter and first H1; if the count < threshold and a block already exists, splice the block OUT. Idempotent.

- [ ] **Step 1 — Read** `assets/extensions/dome.markdown/processors/render-index.ts` (the splice/anomaly/idempotency precedent — esp. `spliceInto`, `anomalyDiagnostics`, the change-collection and "no changes → zero effects" shape) and `src/core/generated-block.ts` (`generatedBlockMarkers`, `findGeneratedBlock`, `replaceGeneratedBlock`). Also read `claims-shared.ts` for `claimsFromMarkdown` and its `ClaimLine` shape `{line, key, value, asOf, anchor}`. Note the `ProcessorContext` shape: `ctx.changedPaths`, `ctx.snapshot.readFile(path)`, `ctx.sourceRef(path, range)`, `ctx.extensionConfig`, and that the processor returns `Promise<ReadonlyArray<Effect>>` and emits a `patchEffect({mode:"auto", changes, reason, sourceRefs})`.

- [ ] **Step 2 — Write the failing unit test** `tests/extensions/dome.claims-render-facts.test.ts`. Mirror the mock-ctx style used by existing processor unit tests (find one that builds a `ProcessorContext` with `changedPaths` + a `snapshot.readFile`; e.g. look at how `tests/extensions/*render*` or `tests/processors/*` construct ctx). Cover:
  1. A page with 3 claim lines → one `patchEffect` writing the page with a `## Current facts` block (between the `dome.claims:current-facts:start/end` markers) containing all three facts, inserted after frontmatter + H1, leaving the body intact.
  2. Re-running on the page that already has the correct block → zero effects (idempotent).
  3. A page with 2 claims (below threshold) and no block → zero effects.
  4. A page with 2 claims that DOES have a stale block → one patch splicing the block OUT.
  5. The rendered block lines do NOT use the `**Key:**` claim grammar (assert the body contains `Status` but not `**Status:**`), so the digest is never re-indexed.

Use claim values WITHOUT inline as-of markers in the source lines for clarity, and assert the rendered line shows the value + `(as of <date>)` once.

- [ ] **Step 3 — Run, verify FAIL** (module missing).

- [ ] **Step 4 — Implement** `render-facts.ts`:
  - A pure `renderCurrentFactsBody(claims: ReadonlyArray<ClaimLine>, page: string): string` that returns the block body (between markers): one line per claim, presentational format `- **${key}** — ${valueWithoutAsOfMarker}${asOf ? ` *(as of ${asOf})*` : ""}${anchor ? ` ([[${page}#^${anchor}]])` : ""}`. NOTE: bold key WITHOUT a colon-inside-bold (`**Status**`, not `**Status:**`) so `CLAIM_LINE_RE` never matches it. Strip any inline `*(as of …)*` from the source value before re-appending the dated suffix (reuse the same regex `claims-shared` uses) so it isn't doubled. Sort claims by line order (document order) for stability.
  - A `renderCurrentFactsBlock(...)` that wraps the body in `generatedBlockMarkers("dome.claims", "current-facts")` + a `## Current facts` heading line ABOVE the start marker (so the heading is human-visible; mirror how render-index keeps its title outside the block, or keep the heading inside — choose: keep `## Current facts` as the first body line INSIDE the block so the whole thing is owned and splices cleanly. Decide and be consistent; inside-the-block is simpler for splice-out).
  - The processor `run`: resolve `current_facts_min_claims` from `ctx.extensionConfig` (default 3; degrade-not-crash: non-positive-int → default, no throw). For each changed `.md` path: read content; parse claims; compute the desired state (block present with rendered body if ≥ threshold, else absent); use `findGeneratedBlock`/`replaceGeneratedBlock` to splice; when absent-and-needed, insert after frontmatter (`---`…`---`) and an immediately-following H1 line if present, else at top of body; when present-and-not-needed, splice out (remove the block + its heading). Collect `FileChangeInput[]`; emit one `patchEffect` if any change; zero effects otherwise. Add `generatedBlockAnomalyDiagnostics` for marker anomalies (mirror render-index). Idempotent: identical desired state → no change → zero effects.

- [ ] **Step 5 — Run, verify PASS** (all 5 cases).

- [ ] **Step 6 — Typecheck + commit.** `bunx tsc --noEmit -p tsconfig.bundles.json` clean.
```bash
git add assets/extensions/dome.claims/processors/render-facts.ts tests/extensions/dome.claims-render-facts.test.ts
git commit -m "feat(dome.claims): render-facts processor compiles a Current facts digest block"
```

---

### Task 3: Register `render-facts` (manifest + grant) + end-to-end scenario

**Files:**
- Modify: `assets/extensions/dome.claims/manifest.yaml`
- Test: a harness scenario under `tests/harness/scenarios/` (mirror an existing garden-render scenario, e.g. a render-index or claims scenario)

- [ ] **Step 1 — Read** `assets/extensions/dome.claims/manifest.yaml` (current `stamp`/`index` entries) and a `dome.markdown` manifest entry for `render-index` to copy the garden + signal-triggers + `read`/`patch.auto` grant shape. Read an existing harness scenario that drives a garden render end-to-end (adopt a vault, run the loop, assert the adopted file content).

- [ ] **Step 2 — Write the failing scenario.** A fixture vault with a `wiki/entities/atlas.md` carrying 3 claim lines (no block yet). Adopt; assert the adopted page now contains a `dome.claims:current-facts:start` … `:end` block listing the three facts, placed after frontmatter. Also assert a second adoption tick is a no-op (idempotent — no new commit / no further change). Follow the exact harness API the sibling scenarios use.

- [ ] **Step 3 — Run, verify FAIL** (processor not registered → no block).

- [ ] **Step 4 — Implement.** Add the `dome.claims.render-facts` processor entry to `manifest.yaml`: `phase: garden`; triggers = `signal` `document.changed` + `file.created` on `wiki/**/*.md` and `notes/*.md` (mirror `stamp`); capabilities = `read` on `["wiki/**/*.md","notes/*.md"]` and `patch.auto` on `["wiki/**/*.md","notes/*.md"]`; `module: processors/render-facts.ts`. If the bundle's processors are also listed in a TS registry/index, wire it there too (check how `stamp`/`index` are registered beyond the manifest — grep for `render-facts` patterns / how `claim-index` is referenced).

- [ ] **Step 5 — Run, verify PASS.** Then the bundle + structural fences: `bun test $(find tests -path "*claims*" -name "*.test.ts") tests/integration/processor-purity.test.ts tests/integration/bundle-deps.test.ts` → 0 fail. If there's a built-in-extensions matrix test (`tests/**` referencing `built-in-extensions-x-phase`), it may assert the processor count per bundle — update the matrix doc/const if the lockstep test requires it (follow the failure's instructions).

- [ ] **Step 6 — Typecheck + commit.** Both tsc projects clean.
```bash
git add assets/extensions/dome.claims/manifest.yaml tests/harness/scenarios/
git commit -m "feat(dome.claims): register render-facts garden processor (manifest + grant + scenario)"
```

---

### Task 4: Sweep charter mints claims for load-bearing facts

**Files:**
- Modify: `assets/extensions/dome.agent/lib/sweep-charter.ts`
- Test: `tests/extensions/dome.agent/sweep-tools.test.ts` (charter-content assertions) + the sweep hermetic scenario (`tests/extensions/dome.agent/sweep.test.ts` or the sweep scenario harness — find where a scripted-provider sweep run is tested)

The charter today (rule in `sweep-charter.ts`) only says *update existing claim lines in place*. Add a rule to MINT a claim line when the material asserts a durable, lookup-worthy fact not already captured as a claim — preserving the one-claim-per-key discipline (mint only if the key is new; otherwise update in place).

- [ ] **Step 1 — Read** `sweep-charter.ts` fully and the existing charter-content tests (grep `sweepCharter` in tests) + the hermetic sweep test that runs a scripted model provider and asserts the emitted patch content.

- [ ] **Step 2 — Write the failing tests.**
  (a) Charter-content: assert `sweepCharter({destination, material, materialDate})` contains the new minting instruction (assert on a stable phrase you will add, e.g. `"Promote a load-bearing fact to a new claim line"` and the one-per-key discipline phrase). 
  (b) Hermetic scenario: a scripted provider whose tool call writes a destination that ADDS a new `**Status:** … *(as of <materialDate>)*` claim line for a load-bearing fact present in the material; assert the emitted PatchEffect content contains the new claim line. (Mirror the existing hermetic sweep test's provider-scripting + assertion exactly; you are adding a case, not changing existing ones.)

- [ ] **Step 3 — Run, verify FAIL** (charter lacks the phrase; scenario depends on the charter wording / your scripted output).

- [ ] **Step 4 — Implement** — add a write-vocabulary rule to the charter, between the "Update existing claim lines" rule and the "Refresh frontmatter" rule:

```
`- **Promote a load-bearing fact to a new claim line** when the material asserts a durable, lookup-worthy attribute of this page's subject — status, owner, stage, a date, a metric, a decision, or a key relationship — that is not already a claim here. Write it as \`**Key:** value *(as of ${materialDate})*\` (do NOT invent a \`^c…\` anchor — the stamper assigns it), placing it with the page's other \`**Key:**\` claim lines (or near the top of the body if there are none). Keep narrative, nuance, reasoning, and one-off observations as prose. Prefer a few high-signal claims over many. If a claim for that key ALREADY exists, update it in place (previous rule) — never add a second line for the same key.`,
```
Keep all existing rules intact.

- [ ] **Step 5 — Run, verify PASS** (charter-content + the new hermetic case + ALL pre-existing sweep tests + the `agent prompt regression` golden — that golden may snapshot the charter; if it fails because the charter changed, UPDATE the golden deliberately, confirming the diff is exactly the new rule).

- [ ] **Step 6 — Typecheck + commit.** Both tsc projects clean.
```bash
git add assets/extensions/dome.agent/lib/sweep-charter.ts tests/extensions/dome.agent/
git commit -m "feat(dome.agent): sweep charter promotes load-bearing facts to claim lines"
```

---

### Task 5: Full-suite gate

- [ ] **Step 1 — Run the whole suite.** `bun test` → 0 fail. (Baseline this branch starts from is 2654 pass; this plan adds tests.)
- [ ] **Step 2 — Both typechecks.** `bunx tsc --noEmit` (root) AND `bunx tsc --noEmit -p tsconfig.bundles.json` — BOTH must report 0 errors. (Run `bunx tsc --noEmit 2>&1 | grep -c "error TS"` → 0. The root project includes tests/; the bundles project does not — Phase A shipped a tsc error that only the root project caught, so check both.)
- [ ] **Step 3 — No commit** (each task already committed). Report the green suite + both tsc counts.

---

## Self-review notes (author)

- **Spec coverage (Links 1 + 1.5):** authoring = Task 4 (sweep mints claims); render = Tasks 1-3 (parser block-safety + the deterministic digest processor + registration). Consolidate prose-promotion is correctly out of scope (design Deferred). Health (Link 3) is Phase C.
- **Idempotency/convergence:** Task 2 render is a whole-block rewrite diffed against the snapshot (zero effects when matching) — the render-index discipline; Task 1 ensures the digest's own lines aren't re-parsed as claims, so no stamp/index cascade off the block.
- **No placeholders:** Tasks include "read X first" steps where the implementer must ground against real precedents (render-index, the hermetic sweep test, the manifest) before coding — deliberate de-risking, with exact APIs, test scaffolds, and the exact charter rule text given.
- **Type consistency:** `renderCurrentFactsBody`/`renderCurrentFactsBlock`, owner `dome.claims`, block `current-facts`, config key `current_facts_min_claims`, threshold default 3 — used consistently across Tasks 2-3. `claimsFromMarkdown`/`ClaimLine` reused from `claims-shared.ts` (no re-implementation).
- **The tsc lesson from Phase A is encoded** in Task 5 (check BOTH tsc projects; root includes tests).
