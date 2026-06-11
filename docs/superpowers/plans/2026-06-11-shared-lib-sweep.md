# Shared-Lib Consolidation Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan batch-by-batch. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One full pass making the shared layers load-bearing everywhere: every consumer uses the `src/core/` stdlib, the daily modules, the `src/surface/` adapter helpers, and new `src/sqlite/` micro-helpers natively — and the duplication found by the three-region discovery (2026-06-11) is folded. Zero behavior change: no output bytes, no exit codes, no diagnostic text, no durable identities move.

**Architecture:** Six independent batches, ordered low-risk → higher-risk. Each batch is a mechanical fold pinned by the existing suite (2,118 tests incl. the tests/core characterization fences from the stdlib branch). Items the discovery surfaced but judged unsafe or low-value are recorded in "Deliberately NOT folded" with reasons — that list is part of the deliverable.

**Branch:** `worktree-shared-lib-sweep+build`. `--no-ff` merge into main when done.

**Hard rules (every batch):**
- Behavior-preserving only. Diagnostic message text, exit codes, JSON output bytes, anchor/stable ids, and idempotency keys are all frozen contracts.
- `bun test` relevant suites green after each batch; full suite before merge.
- Import-direction constraints hold (engine layers; stores independent; adapters never import adapters; bundles import core via relative paths).

---

## Batch 1 — Bundle config/hash folds (dome.agent, dome.markdown, dome.warden, dome.sources)

- [ ] **B1: `sweepLedgerPath` delegates to the shared validator.** `assets/extensions/dome.agent/processors/sweep.ts:106-130` reimplements the gauntlet that `consolidationLedgerPath` (consolidate.ts:49-57) already delegates to `src/core/config-path.ts`. Rewrite `sweepLedgerPath` in the consolidate.ts pattern (`validateRelativeMarkdownPath(raw, "sweep_ledger_path")` + existing local fallback wrapper). Message bytes must be identical — compare the wrapped output strings old vs new for: non-string, non-.md, absolute, traversal.
- [ ] **B3: shared `shortHash`.** Create `src/core/short-hash.ts`: `export function shortHash(value: string, hexChars: number): string` (sha256 → hex → slice). Delegate the three private hash helpers: `dome.markdown/processors/duplicate-detection.ts:343-345` (slice 16), `dome.markdown/processors/validate-wikilinks.ts:266-268` (full digest — pass 64), `dome.warden/processors/integrity.ts:111-114` (slice 12). Outputs byte-identical (same recipe, parameterized length). These feed question idempotency keys, which persist in projection rows — byte-identity is required, so verify each call site's produced key on a fixed input before/after (quick inline node/bun check, reported in the batch summary).
- [ ] **B2 (comment-only): durable-identity note.** On `openLoopStableId` in `assets/extensions/dome.daily/processors/open-loop-surface.ts` (~323): add a comment that the 24-char slice + `dome.daily.open-loop:` prefix is durable identity intentionally NOT folded into `contentAnchorId` (different length, different collision budget), pinned by tests.
- [ ] **B4 (comment-only): sources cross-ref.** `assets/extensions/dome.sources` path validation carries domain-specific checks (sources/ prefix policy); add a one-line comment referencing `src/core/config-path.ts` and why it isn't used wholesale.
- [ ] Gates: `bun test tests/core tests/extensions tests/processors` green; commit.

## Batch 2 — Barrel migration (dome.daily, dome.agent, dome.search, tests)

- [ ] Migrate every importer of `assets/extensions/dome.daily/processors/daily-shared` to direct imports from the six modules (the barrel itself is the symbol→module map). Importers (verify with grep; list from discovery): dome.daily internal ×12 (action-state, attention-discount, attention-shared, carry-forward, close-scaffold, create-daily, normalize-task-syntax, reconcile-tasks, stamp-block-id, task-index — note captured-block.ts/daily-scaffold.ts are the modules themselves, not importers; verify), dome.agent ×5 (ingest, brief, consolidate, sweep, lib/ingest-tools), dome.search ×2 (daily-surface, export-context), tests ×~10 (tests/core ×3, tests/extensions ×4, tests/processors daily-* ×~6, one harness scenario).
- [ ] Import-statement changes ONLY — no logic edits, no symbol renames. After migration: `grep -rln "daily-shared" assets/ tests/ src/` — if zero importers remain, DELETE the barrel file; if any importer is awkward (e.g. would need 5 import statements where 1 sufficed), keeping the barrel for that case is acceptable — report the decision either way.
- [ ] Gates: `bunx tsc --noEmit` clean; `bun test tests/core tests/extensions tests/processors tests/harness` green; commit.

## Batch 3 — dome.agent run-preamble fold

- [ ] The four agent processors repeat a ~40-50 line preamble (step-availability check → config reads → `coreMemorySection` → config-problem diagnostics loop → AgentRunState init): ingest.ts:32-84, consolidate.ts:74-120, brief.ts:88-130, sweep.ts:402-456. Extract `assets/extensions/dome.agent/lib/agent-preamble.ts` with a NARROW helper — do the step check, core-memory read, and the problems→diagnostics loop; KEEP processor-specific config reads, sourceRefs, and settings derivation at the call sites (brief's firedAt-relative date stays local). The helper takes pre-read `{ problem: string | null; code: string; sourceRefs: SourceRef[] }` entries so diagnostic bytes stay caller-owned and identical.
- [ ] Diagnostic codes/messages are pinned by the dome.agent tests — zero text changes. Charters/prompts untouched (snapshot fence must not change).
- [ ] Gates: `bun test tests/extensions/dome.agent tests/integration/agent-prompt-regression.test.ts` green (0 snapshot changes); `bun test tests/harness` green; commit.

## Batch 4 — Store micro-helpers (src/sqlite)

- [ ] **E2: `parseEnum`.** New `src/sqlite/parse-enum.ts`: `parseEnum<T extends string>(value: string, allowed: ReadonlyArray<T>, label: string): T`. Replace the five narrow-or-throw chains: src/ledger/runs.ts:975-1015 (×3), src/ledger/capability-uses.ts:271-280, src/outbox/dispatch.ts:1040-1051. The thrown message format should reproduce the dominant existing format; if any test pins a specific thrown message (check `tests/ledger/runs.test.ts` ~900-950 and outbox tests), match it exactly or keep that one site's message via the label.
- [ ] **E4: shared sha256/ddl hash.** New `src/sqlite/hash.ts`: `sha256(input)` + `computeDdlHash(ddl)`. Replace the four identical private `sha256` helpers: projections/db.ts:368, ledger/db.ts:232, outbox/db.ts:176, answers/db.ts:69 (and the projections extension/processor-version hash uses). Schema hashes must remain identical (tests pin schema-hash stability).
- [ ] **E3: `mapRows`.** New in `src/sqlite/rows.ts` (or alongside row-json): `mapRows<Raw, T>(rows, mapper): ReadonlyArray<T>` = frozen map. Replace the 14 `Object.freeze(rows.map(rowToX))` sites across ledger/outbox/projections/answers.
- [ ] Gates: `bun test tests/ledger tests/outbox tests/projections tests/engine` green; `bunx tsc --noEmit`; commit.

## Batch 5 — Terminal-state dispatch fold (scoped)

- [ ] Add `markTerminal(db, opts)` to `src/ledger/runs.ts`: a discriminated-union over `{status: "succeeded", effectHashes, outputCommit?, ...} | {status: "failed"|"timed_out"|"cancelled", error, ...}` implemented over the existing mark* functions (which STAY exported — tests and other callers keep working; zero churn there). Collapse `markDispatchTerminal` (src/processors/runtime.ts:1437-1478) to a single mapping + `markTerminal` call.
- [ ] EXPLICITLY OUT OF SCOPE: outbox's sent/failed marks (different state machine), `markSkipped` (queued→skipped, not a running-terminal), removing the per-status exports, and adopt.ts restructuring (deferred item 6).
- [ ] Gates: `bun test tests/ledger tests/processors tests/engine tests/harness` green; commit.

## Batch 6 — CLI folds

- [ ] **C2: exit-code constants.** New `src/cli/exit-codes.ts` (`EX_OK = 0`, `EX_USAGE = 64`, `EX_TEMPFAIL = 75`, with the sysexits doc comment); replace the seven local `const EX_USAGE = 64` definitions (cli/index.ts:38, commands/{check:59, doctor:38, http:23, install:70, mcp:36, reanchor:55}). No literal-0/1 sweep (idiomatic returns stay).
- [ ] **C1: withVault adoption ×3.** rebuild.ts:54-116, answer.ts:59-77, sync.ts:167-180 inline the open/try/finally/close ceremony. Introduce a thin `src/cli/vault-helpers.ts` wrapper over `src/surface/adapter.ts::withVault` that lets each command keep its EXACT error mapping and exit codes (sync's open-failure is exit 1, intentionally not 64 — preserve; rebuild's 64-vs-1 split preserved; answer's envelope preserved). Output bytes and exit codes are pinned by tests/cli/commands.test.ts — zero changes allowed.
- [ ] EXPLICITLY OUT OF SCOPE: serve/doctor/inspect/install/reanchor (allowed openVaultRuntime divergences), JSON-formatting changes (see below), status/check/doctor tiering, CLI test split.
- [ ] Gates: `bun test tests/cli` green; `bunx tsc --noEmit`; commit.

## Final gate

- [ ] Full `bun test` from clean state (expect 2,118+ pass / 0 fail).
- [ ] `git diff main --stat` confined to: src/core, src/sqlite, src/cli, src/ledger, src/outbox, src/projections, src/answers, src/processors/runtime.ts, assets/extensions/*, tests (import paths only) + this plan.
- [ ] Zero `.snap` changes; zero test-assertion changes (import-path updates allowed).
- [ ] Final whole-branch review → `--no-ff` merge into main.

---

## Deliberately NOT folded (decisions of record, with reasons)

| Item | Why not |
|---|---|
| `openLoopStableId`/`taskStableId` → `contentAnchorId` | Durable vault identity with a deliberately different hash length (24 vs 8) and collision budget; folding risks re-identifying every open loop. Comment added instead (B2). |
| Wikilink regex (dome.markdown vs dome.graph) | The two regexes differ in capture-group structure and their consumers read different groups; "unifying" changes match-group indexing for one side. Two lines of regex is cheaper than a subtle extraction bug. |
| `JSON.stringify` → `formatJson` in cli/index.ts:72 + default-vault-config.ts:409 | Changes user-visible output bytes (error envelope) and rewrites vault config file formatting. Violates the no-output-change rule. |
| `nowIsoString()` helper | `new Date().toISOString()` is idiomatic; a wrapper adds indirection without removing logic. |
| dome.sources path checks → shared validator | Domain-specific policy (sources/ prefix rules); wrapping would widen the shared validator's scope. Cross-ref comment instead (B4). |
| Outbox terminal marks in markTerminal | Different state machine (pending/sent/failed/abandoned); cross-store unification would couple independent stores. |
| `frozen()`/diagnostic-construction wrappers in engine | Already extracted where shared (staleRecoveryResult); remaining inline sites each carry unique logic. |
| Surface/MCP/HTTP internals | Discovery verified clean — collectors, mutex, catalog-view, error mapping all shared already. |
