# Rewrite Validation Review — dome-v1-engine-model

**Pass:** 1
**Verdict:** Issues Found

## Executive judgment

The new four-concept core (Vault / Proposal / Processor / Effect) is well-specified, internally coherent across the *added* and *rewritten* docs, and the structural fences are concrete: a single `apply-effect.ts` chokepoint, the 7-kind exhaustive switch, the broker with three explicit verdicts (allow / downgrade / deny), Bun.sqlite-keyed `(adopted × extension-set × processor-versions)` cache, MAX_ITER divergence diagnostic, outbox idempotency, ledger-as-dual-with-trailers, and the AC3-lockstep convention extended to off-matrix invariants. A new contributor reading proposals → processors → effects → capabilities → adoption → projection-store → run-ledger can implement the engine. **But the rewrite did not actually carry forward the "carried-forward" axioms.** Five of the six axiom invariants the ledger marks "unchanged" still describe v0.5 mechanisms — writeDocument/moveDocument/appendLog Tools, dispatcher.appendLogEntry, .dome/hooks/, .dome/tools/. They link to retired invariants and matrices (broken wikilinks). Carried-forward gotchas that the ledger said could remain unchanged still cite the retired vocabulary as canonical mechanism. The "hard cut" leaks at every seam where the rewrite assumed the file didn't need touching. A contributor reading RAW_IS_IMMUTABLE and LOG_IS_APPEND_ONLY would implement v0.5.

## Blocking issues

### B1. Carried-forward axiom invariants are not actually rewritten — five contradict the new substrate

Five of the six "carried forward; unchanged" axiom invariants describe v0.5 mechanisms as canonical. MARKDOWN_IS_SOURCE_OF_TRUTH names .dome/hooks/, .dome/tools/, .dome/cli/ as committed; RAW_IS_IMMUTABLE refuses raw via "writeDocument and moveDocument Tools"; LOG_IS_APPEND_ONLY names "appendLog(entry) ... the only public Tool" and "dispatcher.appendLogEntry"; AGENTS_MD_IS_ORIENTATION_SURFACE references "named workflows" and a Related → VAULT_RECONCILES_AFTER_NATIVE_WRITE (retired); ADOPTED_REF_IS_SEMANTIC_CURSOR also has a Related → VAULT_RECONCILES_AFTER_NATIVE_WRITE link.

### B2. Broken cross-references to retired files throughout the substrate

Live `[[wiki/invariants/...]]` and `[[wiki/specs/...]]` links to: VAULT_RECONCILES_AFTER_NATIVE_WRITE, EVERY_WRITE_IS_LOGGED, CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY, HOOKS_CANNOT_BYPASS_TOOLS, WIKILINKS_ARE_FULLPATH, PAGE_TYPE_BY_DIRECTORY, HOOK_DISPATCH_IS_VAULT_BOUND, tool-invariant-enforcement matrix, hooks spec, hook-cycle, hook-non-idempotent gotchas.

### B3. Carried-forward gotchas describe v0.5 mechanisms as canonical

async-read-after-write-staleness, out-of-band-vault-edits, multi-page-partial-write, agent-prompt-regression, transitive-llm-dependency, daemon-off-while-vault-mutating — bodies still cite Tools, hooks, registerHook, drain-hooks, runWorkflow, WorkflowRegistry, scheduled.json (now schedule_cursors).

### B4. linters/wrap-mutating-invoke-consumption.md is v0.5 substrate

Active linter spec on disk references retired symbols (TOOL_REGISTRY, wrapMutatingInvoke, MUTATING_TOOL_NAMES) over the retired HOOK_DISPATCH_IS_VAULT_BOUND invariant. Not listed in the index.md linter set; not in the ledger's retirement list.

### B5. concepts/, entities/, sources/ cite retired invariants

llm-wiki-pattern.md, obsidian.md, karpathy-llm-wiki-gist.md reference PAGE_TYPE_BY_DIRECTORY and WIKILINKS_ARE_FULLPATH. Not in the ledger's audit scope at all — rewriter audited only wiki/specs/ and wiki/invariants/.

## Important issues

### I1. Preamble–body arithmetic divergence

Ledger preamble says "Specs: 6 rewritten ... VISION + 7" — body enumerates 8 rewrites.

### I2. Linter specs are referenced as substrate but not authored as files

Four linters referenced from index.md and from three new axiom invariants; only the v0.5 wrap-mutating-invoke-consumption file exists in linters/. Without no-retired-symbol-names as a runnable check, B1/B2/B3/B5 had no structural fence at CI.

### I3. page-schema daily-type forward pointer

page-schema.md introduces `daily` type before the four-default-types section; a forward pointer to §"Extension types" prevents the misread.

## Recommended repairs (ranked)

1. Rewrite the five carried-forward axiom invariants against v1 mechanisms (closes B1, half of B2)
2. Author no-retired-symbol-names as runnable check; run across docs/ (closes B2, prevents B5 recurrence)
3. Rewrite six carried-forward gotchas with v1 vocabulary (closes B3)
4. Delete or rewrite linters/wrap-mutating-invoke-consumption.md; add §"Linters" to ledger (closes B4)
5. Author linter spec stubs for the four new linters (closes I2)
6. Fix preamble arithmetic; audit concepts/entities/sources/syntheses (closes I1 + B5)

**Disposition:** Repair → re-validate
