# Tier 2 Cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. All tasks are behavior-preserving refactors; the gate is "full suite green + both tsc (root AND bundles) 0 errors, before AND after." These touch TESTED CONTRACTS (CLI exit codes + message bytes, MCP/HTTP response shapes, SQL query results, schema-mismatch policies) — preserve exact wording/behavior; the suite is the oracle. Steps use `- [ ]`.

**Goal:** Land the meatier Tier 2 consolidations from the repo sweep: collapse the duplicated view-running stacks, the CLI command scaffold, the openVault failure envelope, the SQL SELECT de-dup, the db.ts opener skeleton, and the dome.daily twin helpers.

**Source:** the 5-agent sweep (2026-06-15). Line numbers are from that sweep; main has since advanced — each task READS current files first and grounds against them.

**Ordering:** Task 1 (view-stack) before Task 2 (CLI scaffold) — the scaffold builds on the consolidated runner. Otherwise independent.

---

### Task 1 — Collapse the two parallel view-running stacks (`surface/view.ts` ⇄ `surface/adapter.ts`)

`src/surface/view.ts` is an older parallel stack that duplicates `src/surface/adapter.ts`. Retire the duplication onto `adapter.ts` (the newer shared seam MCP/HTTP already use).

- [ ] **Read first:** `src/surface/view.ts` (esp. `runStructuredViewCommand`, `validateStructuredViewResult`, `translateViewResult`, `firstPartyViewNotFoundMessage`, `OLD_FIRST_PARTY_CONFIG_HINT`) and `src/surface/adapter.ts` (`runCatalogView`, `validateStructuredRun`, `catalogViewProblemMessage`, `viewNotFoundMessage`). Read the CLI consumers: `src/cli/commands/{query,export-context,lint,today}.ts` and the catalog `src/surface/view-catalog.ts` (`FirstPartyViewEntry`). Map exactly what each duplicated function does and which commands call which.
- [ ] **Consolidate** the duplicated logic so there is ONE implementation of: the structured-view run, the structured-result validation, and the view-failure problem→message rendering. Prefer keeping `adapter.ts`'s versions (`runCatalogView`/`validateStructuredRun`/`catalogViewProblemMessage`) as canonical; reduce `view.ts` to a thin CLI-facing wrapper over them (or move the CLI-needed bits into adapter.ts and update imports). `firstPartyViewNotFoundMessage` + `OLD_FIRST_PARTY_CONFIG_HINT` (view.ts) are byte-identical to `viewNotFoundMessage` (adapter.ts) — collapse to one. `today.ts`'s hand-rolled problem→message switch should use the shared `catalogViewProblemMessage`.
- [ ] **Thread the catalog entry:** where commands re-spell `commandName`/`expectedViewName`/`expectedSchema`/`notFoundMessage` from a `FIRST_PARTY_VIEWS.<x>` entry, pass the `FirstPartyViewEntry` whole (the entry already carries those fields). `runCatalogView(vault, entry, args)` already takes the entry; make the CLI path do the same.
- [ ] **CRITICAL — preserve exact behavior:** every view-failure message string, every CLI exit code, and the JSON/human output shape must be byte-identical (these are tested in `tests/cli/commands/*` and the cli-surface scenarios). If consolidating would change any emitted string, keep the string identical (the goal is one code path, same output).
- [ ] Verify: `bun test $(find tests -path "*cli*" -name "*.test.ts"; find tests -path "*surface*" -name "*.test.ts"; find tests -path "*cli-surface*" -name "*.scenario.test.ts")` → 0 fail; full `bun test` → 0 fail; both tsc 0.
- [ ] `git commit -m "refactor(surface): collapse the duplicate view-running stack (view.ts onto adapter.ts; thread catalog entry)"`

---

### Task 2 — CLI structured-view command scaffold

`src/cli/commands/{query,export-context,lint}.ts` share a ~50-line skeleton: usage-guard → run structured view → on error `printViewCommandError` → `printViewCommandMessages(structuredViewBrokerMessages(...))` → JSON-or-render branch → try/catch `*-failed`. Only the arg-building and the final human renderer differ.

- [ ] **Read** the three command files + `today.ts` (which is similar) and identify the exact shared skeleton vs the per-command bits (args parse + human render).
- [ ] Extract a `runCliStructuredView({ entry, args, renderHuman, jsonMode, ... })` helper (place in `src/cli/` or `src/surface/`), so each command body becomes ~15 lines: build args, call the helper with its `FirstPartyViewEntry` + a human-renderer callback. Preserve each command's exact exit-code and error-string contract.
- [ ] **CRITICAL:** the per-command tests pin exit codes + output bytes. The `run.ts` dynamic `<name>` path is the deliberate stringly-typed exception — leave it. Don't change observable behavior.
- [ ] Verify: the three commands' tests + full suite → 0 fail; both tsc 0.
- [ ] `git commit -m "refactor(cli): extract shared structured-view command scaffold (query/export-context/lint)"`

---

### Task 3 — Share the `openVaultRuntime` failure envelope

The `openVaultRuntime failed (…) Run \`dome init\`` message + the `error.kind==="runtime-open-failed" ? error.cause.kind : error.kind` derivation are duplicated across `src/mcp/server.ts`, `src/http/server.ts`, `src/cli/command-error.ts`, and `src/cli/commands/answer.ts`. `adapter.ts` already exports `vaultOpenFailureMessage` + `openVaultErrorKind`.

- [ ] **Read** the four call sites + `adapter.ts`'s `vaultOpenFailureMessage`/`openVaultErrorKind`. Confirm the message text + kind derivation are the same in all four.
- [ ] Route all four through the shared `vaultOpenFailureMessage`/`openVaultErrorKind` from `adapter.ts` (or extend them minimally to cover the exact text). KEEP the per-protocol envelope wrapping (MCP tool result vs HTTP `Response`/status code vs CLI stdout) — only the message+kind derivation consolidates. (`answer.ts` also re-implements `openVaultErrorKind` inline — replace with the import.)
- [ ] **CRITICAL:** HTTP status codes, MCP `isError`, and CLI exit codes stay per-adapter and unchanged; only the shared message/kind string is sourced once.
- [ ] Verify: mcp/http/cli tests + full suite → 0 fail; both tsc 0.
- [ ] `git commit -m "refactor(adapters): share openVaultRuntime failure message/kind across mcp/http/cli"`

---

### Task 4 — SQL SELECT de-dup (diagnostics + questions)

- [ ] **Diagnostics** (`src/projections/diagnostics.ts`): 4 near-identical SELECTs (`QUERY_ALL_SQL`, `QUERY_BY_SEVERITY_SQL`, `QUERY_BY_PROCESSOR_SQL`, `QUERY_BY_SEVERITY_AND_PROCESSOR_SQL`) share the big `NOT EXISTS (… newer.id > d.id …)` latest-wins subquery; only the `severity = ?` / `processor_id = ?` predicates vary. Compose ONE base SELECT + the latest-wins subquery as constants + a small dynamically-built WHERE (mirror `runsWhereClause` in `src/ledger/runs.ts`). `queryDiagnosticRecords` already branches on the same two optional filters — wire it to the composed query. Preserve exact result ordering + dedup semantics.
- [ ] **Questions** (`src/projections/questions.ts`): 5 SELECTs repeat the same 11-column projection with only the WHERE varying (`answered_at IS NULL` / `IS NOT NULL` / `id = ?` / none). Extract `SELECT_QUESTIONS_BASE` (the column list + FROM) + appended WHERE. The column list must stay identical (it maps to the row decoder).
- [ ] **CRITICAL:** these feed `dome check`/`lint`/recovery flows; result rows + ordering must be byte-identical. Build the WHERE by composition, NOT string interpolation of values (keep `?` params).
- [ ] Verify: `bun test tests/projections` + the diagnostics/questions accessor tests + full suite → 0 fail; both tsc 0.
- [ ] `git commit -m "refactor(projections): de-duplicate diagnostics + questions SELECTs (base + composed WHERE)"`

---

### Task 5 — Shared db.ts opener mechanics (keep divergent policies)

The four `db.ts` openers (`src/projections/db.ts`, `src/ledger/db.ts`, `src/outbox/db.ts`, `src/answers/db.ts`) share a near-identical skeleton: mkdir-parent → `new Database` + `configureSqliteConnection` → `applyDdl` (BEGIN/COMMIT/ROLLBACK loop) → `readStoredSchemaHash(table, db)` → meta-row. Plus four private `applyDdl` + four `readStoredSchemaHash` copies.

- [ ] **Read** all four openers carefully. Identify the GENUINELY-identical mechanics (`ensureParentDir`, the `applyDdl` transaction loop, `readStoredSchemaHash(db, metaTable)`) vs the per-store POLICY (projections wipe-on-mismatch / ledger refuse / outbox additive-migrate / answers refuse) — the policy divergence is the deliberate durability distinction and MUST stay per-store.
- [ ] Create `src/sqlite/open-store.ts` (or extend `src/sqlite/`) with the shared mechanics: `ensureParentDir(path)`, `applyDdlInTransaction(db, ddl)`, `readStoredSchemaHash(db, metaTable)`. Each opener imports them; delete the four `applyDdl` + four `readStoredSchemaHash` copies. Leave each opener's mismatch-policy branch exactly as-is.
- [ ] **CRITICAL (highest-risk task):** do NOT merge or alter any store's mismatch policy. The projections wipe-and-rebuild, ledger/answers refuse, and outbox additive-migrate behaviors must be byte-identical. The schema-mismatch tests (`tests/projections/db.test.ts` etc.) are the gate.
- [ ] Verify: `bun test tests/projections tests/ledger tests/outbox tests/answers` + the rebuild/schema-skew tests + full suite → 0 fail; both tsc 0.
- [ ] `git commit -m "refactor(sqlite): share db opener mechanics (mkdir/applyDdl/schema-hash); keep per-store policies"`

---

### Task 6 — dome.daily twin dedup + twin renderers

- [ ] **`uniqueOpenLoops` / `uniqueSettledOpenLoops`** (`assets/extensions/dome.daily/processors/carry-forward.ts`) are identical except element type — both `Set`-dedup keyed by the same `openLoopIdentity`. Collapse to one generic `uniqueBy<T>(items, keyFn)` (place in `daily-types.ts` or the bundle's shared lib). Confirm `openLoopIdentity` is the shared key for both.
- [ ] **`renderOpenLoopSource` / `renderSettledOpenLoopSource`** (`assets/extensions/dome.daily/processors/open-loop-surface.ts`) compute the same `#followup` prefix + `(from [[…]])` suffix, differing only in checkbox marker (`[ ]` vs `[${state}]`). Parameterize on a `status`/marker arg.
- [ ] **CRITICAL:** the rendered daily-note line bytes are pinned by the dome.daily scenario tests; output must be byte-identical. Confirm equivalence before merging.
- [ ] (Optional, only if cleanly the same key shape) note whether the wider `dedupBy<T>` rollup across `export-context.ts`'s `uniqueOpenLoops/Decisions/Questions/Diagnostics` is worth it — if it adds risk, SKIP and report.
- [ ] Verify: dome.daily + search extension tests + `processor-purity` + full suite → 0 fail; both tsc 0.
- [ ] `git commit -m "refactor(dome.daily): collapse twin open-loop dedup + renderer helpers"`

---

### Task 7 — Full-suite gate

- [ ] `bun test` → 0 fail. (Known: 2 LLM-backed dome.daily scenarios can TIME OUT under full-suite load — if they're the only failures, re-run them in isolation to confirm pass, then treat as PASS.) `bunx tsc --noEmit` AND `bunx tsc --noEmit -p tsconfig.bundles.json` → 0 each (`grep -c "error TS"`). Report. No commit.

---

## Self-review notes
- Every task behavior-preserving; the gate is the suite + both tsc. The Phase-A lesson (check BOTH tsc projects) is encoded.
- Task 5 is the highest-risk (durability policies) — the plan explicitly fences the policy branches as untouchable; the schema-mismatch tests are the oracle.
- Tasks 1+3 are message-byte-sensitive (CLI/MCP/HTTP failure strings) — consolidation must keep strings identical.
- Guardrails: no new core primitive; `surface-adapters-dont-import-adapters` linter (mcp≠cli) respected; bundle independence (Task 6 within-bundle); the four stores stay separate (Task 5 lifts only mechanics).
