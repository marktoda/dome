# End-of-run Coverage Review — dome-compiler-reframe

**Verdict:** Covered with minor drift

## Coverage table

The delta ledger's only non-Deferred implementation surface is item (1) under "Deferred" (the implementation surface promised for this pass) plus the in-pass deletions named under "Files removed or deprecated." All other ledger entries are doc-only rewrites that landed in the pre-implementation commits.

| Delta entry (ledger ref) | Plan task(s) | Diff hunks | Status |
|---|---|---|---|
| `dome init` writes AGENTS.md from vault config | T6, T7 | `src/agents-md.ts` (new, 98 lines); `src/cli/commands/init.ts:6-8,33-37` | Covered |
| `dome init` writes CLAUDE.md shim | T7 (preserved) | `src/cli/commands/init.ts:36` (existing `SHIPPED_CLAUDE_MD_SHIM`) | Covered |
| `dome doctor --repair` regenerates templated; preserves user-prose | T9 | `src/cli/commands/doctor.ts:414-427`; `src/cli/cli.ts:47-48,67,348` | Covered |
| `dome doctor --time-since-reconcile` | T8 | `src/cli/commands/doctor.ts:429-438`; `src/cli/cli.ts:46,66,347` | Covered |
| `dome doctor` reports AGENTS.md / CLAUDE.md drift | T10 | `src/cli/commands/doctor.ts:278-297` | Covered |
| Watcher-driven `appendLog` for native writes | T11 | `src/hooks/log-out-of-band-write.ts` (new); `src/vault.ts:199-210`; `src/shipped-defaults.ts:27-31` | Covered |
| `inbox/review/` shipped-default | T5 | `src/vault-scaffold.ts:84` | Covered |
| Delete `SENSITIVE_GOES_TO_INBOX` (types) | T1 | `src/types.ts:52,78` | Covered |
| Delete sensitivity from `SHIPPED_VAULT_CONFIG` | T2 | `src/shipped-defaults.ts:23` | Covered |
| Delete `writeDocument` sensitivity codepath + `sensitivity_classified` opts | T3 | `src/tools/write-document.ts:5,15,110-120`; `src/tools/schemas.ts:9,26,83-85` | Covered |
| Delete `abstract-surface.ts` sensitivity-classify comment + filter | T4 | `src/abstract-surface.ts:19,147-149` | Covered |
| Delete `src/prompts/builtin/sensitivity-classify.md` | (ledger "Files removed") | landed in `bc5e09c` (spec-rewrite commit) | Covered |
| Delete `tests/invariants/sensitive-goes-to-inbox.test.ts` | (ledger "Files removed") | landed in `bc5e09c` (spec-rewrite commit) | Covered |
| Regression test: AGENTS_MD_IS_ORIENTATION_SURFACE | T12 | `tests/invariants/agents-md-is-orientation-surface.test.ts` (new) | Covered |
| Regression test: VAULT_RECONCILES_AFTER_NATIVE_WRITE | T12 | `tests/invariants/vault-reconciles-after-native-write.test.ts` (new) | Covered |

## Findings

### F1. Sensitivity references survive in two shipped builtin prompt files

- **Severity:** Medium
- **Category:** Coverage gap (residual)
- **Why it matters:** The ledger asserts "the sensitivity-classification feature is retired entirely." Two shipped-default prompts shipped to every vault still tell agents about the retired invariant — a fresh consumer reading these will believe `SENSITIVE_GOES_TO_INBOX` is still a thing.
- **Evidence:**
  - `src/prompts/builtin/system-base.md:19` — "Sensitive content routes through `inbox/review/` if `SENSITIVE_GOES_TO_INBOX` is enabled."
  - `src/prompts/builtin/ingest.md:21` — "If `SENSITIVE_GOES_TO_INBOX` is enabled, classify content first (sensitive content routes to `inbox/review/`)."
  - The plan's grep step (Task 4 Step 3: `grep -rln "SENSITIVE_GOES_TO_INBOX\|sensitive_classified\|sensitivity_classified" tests/`) scoped to `tests/` only; `src/prompts/builtin/*.md` were missed.
- **Recommended fix:** Strip the two lines in a follow-up commit; these are markdown prose, no code-shape edit. Ledger entry would read "code-side sensitivity plumbing — shipped prompt content."

### F2. Ledger's "(deleted) sensitivity test" rolled into the spec-rewrite commit rather than the implementation pass

- **Severity:** Low
- **Category:** Plan-implementation seam
- **Why it matters:** The ledger §"Files removed" lists `src/prompts/builtin/sensitivity-classify.md` and `tests/invariants/sensitive-goes-to-inbox.test.ts` as deletions in this pass. They landed in commit `bc5e09c` (the spec-rewrite commit), not the implementation commits. Coverage holds — the files are gone in the branch HEAD — but the audit trail reads as if the rewrite pass deleted code, which the rewrite scope explicitly excluded.
- **Evidence:** `git log --diff-filter=D bc5e09c -- src/prompts/builtin/sensitivity-classify.md tests/invariants/sensitive-goes-to-inbox.test.ts` returns the spec-rewrite commit; the ledger §"What this rewrite *did not* do" item 1 states "Implementation code: not changed."
- **Recommended fix:** Cosmetic; the audit trail in any future ledger should either (a) land code deletions only in implementation commits, or (b) name the spec-rewrite-commit code deletions explicitly in §"What this rewrite did".

## What looked right

- **TDD shape per task.** Each task's failing-test-first → impl → green sequence shows in commit order (`tests/agents-md.test.ts` lands in the same commit as `src/agents-md.ts`; `tests/cli/doctor-flags.test.ts` extends before the `--repair` / `--time-since-reconcile` impl).
- **HOOKS_CANNOT_BYPASS_TOOLS preserved in the watcher-driven hook.** `src/hooks/log-out-of-band-write.ts` calls `ctx.tools.appendLog` rather than writing directly, and excludes `log.md` / `index.md` to avoid cycles — exactly the cycle hazard the ledger's two-enforcement-paths framing flagged.
- **Test-vault helper updated symmetrically.** `tests/helpers/make-test-vault.ts:40-46` now writes AGENTS.md + CLAUDE.md by default so the new doctor drift check doesn't break unrelated tests; the one test that *needs* the absent-file case (`tests/mcp/instructions-builder.test.ts:88`) explicitly removes AGENTS.md to exercise the fallback. The substrate change propagated through test fixtures cleanly.
