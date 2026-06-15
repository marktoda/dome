# Repo Cleanup Sweep — Implementation Plan (Tier 1 + Brand type)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Each task is behavior-preserving cleanup; the gate is "full suite green + both tsc clean before AND after" (no new feature ⇒ no failing-test-first; the existing 2683-test suite is the regression oracle). Steps use `- [ ]`.

**Goal:** Land the low-risk hygiene wins from the repo-wide sweep — delete verified-dead code, collapse verbatim duplications, close one public-surface gap — plus introduce a shared `Brand<>` type. All behavior-preserving.

**Verification rule for every task:** the change must NOT alter behavior. After each task: run the relevant suites + `bunx tsc --noEmit` (root) AND `bunx tsc --noEmit -p tsconfig.bundles.json` (both 0 errors). Dead-code deletions must be re-verified truly-unused (grep `src/ assets/ tests/`, manifest `module:` paths, registered command/view names, and `src/index.ts` re-exports) before removing.

**Source:** the 5-agent sweep (engine, storage, adapters, core, extensions), 2026-06-15.

---

### Task 1 — Delete verified-dead code

All confirmed zero-reference by the sweep (re-verify each before deleting). Pure removals.

- [ ] `src/projections/jobs.ts` — remove `NEXT_ELIGIBLE_JOB_SQL` (`:83-91`), `nextEligibleJob` (`:247-257`), `MARK_RUNNING_SQL` (`:93-100`), `markJobRunning` (`:284-294`). Superseded by the atomic `claimNextEligibleJob`. (~50 lines incl. stale docstrings.)
- [ ] `src/processors/execution-error.ts` — remove `executionErrorToJson` (`:19-21`), an unused one-line JSON.stringify wrapper.
- [ ] `src/core/proposal.ts` — remove `ProposalState` + `ProposalStateSchema` (`:105-111`, `:173-180`) and `AdoptionResultSchema` (`:182-191`). KEEP the `AdoptionResult` *type* (used + re-exported). Confirm none are re-exported from `src/index.ts`.
- [ ] `assets/extensions/dome.agent/lib/brief-shared.ts` — remove the 8 dead `BRIEF_*_START`/`BRIEF_*_END` const re-exports (`:71-78`); call sites use `YESTERDAY_BLOCK.start` etc. directly.
- [ ] `src/cli/commands/run.ts` — remove the unused `commandFlags` field on `RunCommandOptions` (`:58`) and its merge (`:103`); no caller sets it.
- [ ] Verify + commit:
  - `bun test` → 0 fail; `bunx tsc --noEmit` and `... -p tsconfig.bundles.json` → 0 errors each.
  - `git commit -m "chore(cleanup): delete verified-dead code (jobs/execution-error/proposal/brief/run)"`

---

### Task 2 — Engine consolidations (behavior-preserving)

Respect the downward-only layer import rule (core < garden < operational < host).

- [ ] **`answerHandlerFailure`** is duplicated verbatim: `src/engine/host/question-answering.ts:73-96` and `src/engine/operational/question-auto-resolution.ts:295-317` (differ only in host's extra `result.result.{...}` nesting). Extract one helper taking `{diagnostics, runs}` into operational (or core); host unwraps its nesting at the call site and imports down.
- [ ] **`predicateNamespace`** duplicated verbatim within core: `src/engine/core/capability-broker.ts:684-688` and `src/engine/core/effect-capability-use.ts:128-132`. Extract one intra-core util. DO NOT fold in the projections variant (`facts.ts`/`query-view.ts`) — different semantics (`string` return / `idx === -1`); that pair is Task 3.
- [ ] **`currentAdopted?.() ?? adopted`** idiom repeated at 8 sites (`garden-patch-dispatch.ts:103`, `garden.ts:541`, `question-auto-resolution.ts:132,240`, `operational-work.ts:187`, `jobs.ts:189`, `scheduler.ts:404`, `answers.ts:190`). Extract a tiny `resolveCurrentAdopted(opts)` helper at/below the lowest consuming layer; pure extraction.
- [ ] **Job failure branches:** `src/engine/operational/jobs.ts:286-294` (quarantine) and `:296-…` (retryable !== true) have identical bodies (`markJobFailed` + return `{status:"failed",…}`). Fold to one guard `code === "processor.quarantined" || retryable !== true`.
- [ ] **`AdoptSubProposalFn` vs `AdoptGardenSubProposalFn`** (`garden.ts:160`, `garden-sub-proposals.ts:21`) are the same signature `(proposal, cascadeDepth) => Promise<AdoptionResult>`, used interchangeably. Unify to one canonical type alias. Confirm neither is re-exported from `src/index.ts` (internal-only).
- [ ] Verify + commit: relevant engine tests + `tests/integration/engine-import-direction.test.ts` + full suite → 0 fail; both tsc clean. `git commit -m "refactor(engine): consolidate duplicated helpers (answer-failure, predicate-namespace, current-adopted, job-failure, sub-proposal-fn)"`

---

### Task 3 — Storage consolidations (behavior-preserving)

Keep the four stores' divergent durability policies; only lift mechanically-identical helpers.

- [ ] **4× `errorMessage`**: `src/projections/db.ts:822`, `src/ledger/db.ts:418`, `src/outbox/db.ts:370`, `src/answers/db.ts:193` are byte-identical. Lift one into `src/sqlite/` (e.g. `sqlite/error-message.ts`); import in all four. (A more robust `errorMessage` exists at `src/processors/execution-error.ts:34` — do NOT couple storage to processors; make the sqlite one standalone.)
- [ ] **Projections table-shape check**: `src/projections/db.ts` `REQUIRED_TABLE_COLUMNS` (`:258-360`) + `projectionSchemaShapeMatches`/`tableColumns` (`:864-881`) reimplement the shared `validateSqliteTableShapes` (`src/sqlite-shape.ts:10`) the other 3 stores use. Retype `REQUIRED_TABLE_COLUMNS` as `SqliteTableShape[]` (keep it — `PROJECTION_TABLE_NAMES` derives from it at `:362`) and delegate the column check; drop `tableColumns`/the per-column loop.
- [ ] **search.ts row-json**: `src/projections/search.ts:243-272` re-implements `parseSourceRefs` + `textRange`; replace with the shared `parseSourceRefsColumn` + `textRange` from `src/sqlite/row-json.ts:41-75` (used by facts/diagnostics/questions/outbox). Preserves the labeled parse-error wrap.
- [ ] **`predicateNamespace` + subject-from-(kind,id)**: `src/projections/facts.ts:275-296` vs `src/projections/query-view.ts:154-176` (query-view's comments say "mirroring `predicateNamespace` in ./facts"). Export `predicateNamespace` + a `subjectFromKindId` from `facts.ts`; query-view imports them.
- [ ] Verify + commit: storage tests + full suite → 0 fail; both tsc clean. `git commit -m "refactor(storage): share errorMessage, table-shape check, row-json, and predicate/subject helpers"`

---

### Task 4 — Extensions consolidations + stale comments (behavior-preserving)

Within-bundle only (bundle independence preserved).

- [ ] **`positionAt`** byte-identical in `dome.markdown/processors/wikilinks.ts:469` and `broken-images.ts:153`. Extract to a `dome.markdown/lib/` helper (sibling to `frontmatter-keys.ts`); both import it.
- [ ] **`normalizedTokens`** byte-identical in `dome.search/processors/topic-relevance.ts:120` and `recall.ts:325`. Consolidate into `dome.search/processors/search-input.ts` (the bundle's shared input helper); both import.
- [ ] **graph-fact guard** `isGraphFact`/`isSearchGraphFact` (`dome.search/processors/ranking.ts:629`, `query.ts:376`) — same two-predicate check. Keep the `Pick<FactEffect,"predicate">` version in `ranking.ts`, import into `query.ts`.
- [ ] **Stale comments:** `dome.daily/processors/daily-scaffold.ts:2` and `captured-block.ts:2` claim "Moved verbatim from daily-shared.ts" — that file was deleted. Remove/correct those comment lines.
- [ ] Verify + commit: claims/search/markdown/daily extension tests + `tests/integration/processor-purity.test.ts` + full suite → 0 fail; both tsc clean. `git commit -m "refactor(extensions): dedupe positionAt/normalizedTokens/graph-fact-guard; drop stale daily-shared comments"`

---

### Task 5 — `Brand<Base, Name>` type + helper, and close the SearchDocumentEffect public-surface gap

- [ ] **Create `src/core/brand.ts`**: `export type Brand<B, N extends string> = B & { readonly __brand: N };` and `export function brand<T extends Brand<string, string>>(s: string): T { return s as T; }` (header: single source for the branded-string idiom).
- [ ] Re-express the 5 hand-rolled brands using it, PRESERVING the public type names + the thin named cast wrappers (they're re-exported / part of the public type identity):
  - `src/core/source-ref.ts:27,30` — `CommitOid`, `BlobOid` → `Brand<string,"CommitOid">` / `"BlobOid"`; keep `commitOid`/`blobOid` (`:149,154`) as thin wrappers over `brand` (preserve their exported names + the future-validation comment).
  - `src/core/vault-path.ts:11` — `VaultPath` → `Brand<string,"VaultPath">` (keep `parseVaultPath`/constructors).
  - `src/core/processor.ts:56,59` — `TreeOid` → `Brand<string,"TreeOid">`; `treeOid` wrapper over `brand`.
  - `src/engine/core/runner-contract.ts:49` — `RunId` → `Brand<string,"RunId">`.
  Verify the `__brand` literal for each stays IDENTICAL (these brands are nominal — changing the literal would change type identity). Re-export `Brand`/`brand` from `src/index.ts` only if the existing brands are publicly exported (match current export posture; don't widen surface unnecessarily).
- [ ] **Public-surface consistency:** `src/index.ts:41-74` exports every Effect kind's type + constructor EXCEPT the search-document family. Add `SearchDocumentEffect`, `SearchDocumentEffectInput`, and the `searchDocumentEffect` constructor (from `src/core/effect.ts`) to `src/index.ts`, matching the ordering/style of the sibling effect exports.
- [ ] Verify + commit: full suite (esp. anything touching brands — source-ref/vault-path/processor/runner-contract) + both tsc clean. `git commit -m "refactor(core): add Brand<> helper collapsing 5 branded types + 3 casts; export SearchDocumentEffect from index"`

---

### Task 6 — Full-suite gate

- [ ] `bun test` → 0 fail (baseline 2683). `bunx tsc --noEmit` AND `... -p tsconfig.bundles.json` → 0 errors each (`grep -c "error TS"` → 0). Report. No commit.

---

## Self-review notes
- Every task is behavior-preserving; the suite + both tsc are the gate (the Phase-A lesson: check BOTH tsc projects — root includes tests).
- Dead-code (Task 1) must be re-verified unused incl. `src/index.ts` re-exports + dynamic dispatch before deletion — the sweep verified, but the implementer re-confirms.
- Brand (Task 5): the `__brand` string literals are nominal type identity — keep each IDENTICAL; only the declaration syntax changes. Public cast-helper names (`commitOid`/`blobOid`/`treeOid`) preserved as wrappers.
- Guardrails honored: no new core primitive, no invariant touched, no bundle-independence break (Task 4 is within-bundle), engine layer imports stay downward-only (Task 2).
