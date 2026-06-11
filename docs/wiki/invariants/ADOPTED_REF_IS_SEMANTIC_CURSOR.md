---
type: invariant
created: 2026-05-27
updated: 2026-06-10
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
coverage: off-matrix
enforced_at: src/engine/core/adopt.ts
enforced_by:
  - tests/harness/scenarios/cli-surface/reanchor-divergence.scenario.test.ts
  - tests/cli/sync.test.ts
tier: axiom
---

# ADOPTED_REF_IS_SEMANTIC_CURSOR

**Tier:** Axiom — non-disable-able.

**Statement:** `refs/dome/adopted/<branch>` points to the latest commit Dome has fully adopted (the fixed-point adoption loop converged without blocking diagnostics) and considers safe for trusted semantic queries against the named branch. The engine advances it only at the end of a successful adoption pass per [[wiki/specs/adoption]] §"The fixed-point adoption loop". Until the ref exists for a branch, `dome status` reports adoption as "uninitialized" and the first `dome sync` initializes it.

**Why:** A first-class git ref (rather than a per-machine state file) means:

- **Crash recovery** is derivable from git alone. `git show-ref refs/dome/adopted/main` is authoritative; no `.dome/state/` cursor file's existence and freshness affect the answer.
- **Divergence detection** is structural. A force-push, hard-reset, or rebase that rewrites HEAD's history is detectable by checking whether `adopted` is an ancestor of `HEAD`; a file-based cursor could not surface this without bespoke comparison logic.
- **"What's queued for adoption"** is a single git query: `git log refs/dome/adopted/<branch>..HEAD`. The engine-internal Proposal that `dome sync` / `dome serve` constructs uses this range directly per [[wiki/specs/proposals]] §"Local-eventual mode".
- **Hosted-protected mode** (v1.5, designed-for in [[wiki/specs/adoption]] §"Hosted-protected mode") layers cleanly: in hosted mode, `refs/heads/main` is the adopted trunk (PR merges replace the ref advance); the cursor shape is the same git ref pattern, only the cursor name differs.

**Structural enforcement:** Off-matrix. The advance-ref step lives at the `setAdoptedRef` call inside `src/engine/core/adopt.ts` — the single chokepoint at the tail of the engine adoption loop (per [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]]). Fast-forward-only by default: refuses to advance if `sha` is not a descendant of the current ref value. The internal `forceAdvance: true` opt-out has exactly one user-facing caller: `dome reanchor` (`src/cli/commands/reanchor.ts`, [[wiki/specs/cli]] §"`dome reanchor`"), the explicit divergence recovery verb that refuses when the vault is *not* diverged and records the old adopted SHA under `refs/dome/backup/` before moving. The `getAdoptedRef` reader is the symmetric companion; the read side is re-exported from `@dome/sdk` core for consumer use, but the write side (`setAdoptedRef`) is **not** re-exported — only the engine (and the named recovery chokepoint) advances the ref.

**Counter-example (what this invariant rules out):** A Dome installation that reports its "trusted state" via a `.dome/state/` cursor file alone — the file lives outside git, can drift from reality, and gives no structural signal of divergence. The v1 substrate retires that pattern entirely; the ref is the only cursor.

**Test guarantee:** `tests/invariants/adopted-ref-is-semantic-cursor.test.ts` is the AC3 lockstep file. Behavioral coverage lives in `tests/cli/sync.test.ts` and `tests/engine/adopt.test.ts` with these cases:

1. **Fresh vault.** `dome sync` initializes `refs/dome/adopted/main` at the Proposal's adopted head; subsequent `dome status` reports no pending and zero divergence.
2. **Source-ahead vault.** User commits land on top of the existing adopted ref; `dome sync` constructs a Proposal `adopted..HEAD`, the adoption loop reaches fixed point, the engine fast-forwards the ref to the new head (possibly through a closure commit).
3. **Divergent vault.** HEAD's ancestry no longer contains the prior adopted commit (simulated by `git reset --hard` to an earlier commit and then committing a different change); `dome sync` refuses before constructing a Proposal, preserves the adopted ref, and points the operator at the recovery paths (`git reflog` restore or `dome reanchor`). The reanchor flow itself — refusal when clean, backup ref, post-reanchor adoption — is covered by `tests/harness/scenarios/cli-surface/reanchor-divergence.scenario.test.ts`.

**Related:**

- [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]] — markdown is canonical; the ref is a marker over it.
- [[wiki/invariants/VAULT_IS_GIT_REPO]] — the ref exists *in* the git repo (refusing to open non-git vaults at the door).
- [[wiki/invariants/ALL_MUTATION_GOES_THROUGH_ADOPTION]] — every native write becomes a Proposal; the loop that advances the ref handles them.
- [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]] — `setAdoptedRef` lives inside the engine boundary.
- [[wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS]] — the structural sibling: engine commits between adopted and HEAD are trailer-bearing.
- [[wiki/specs/adoption]] — the adoption loop this invariant pins.
- [[wiki/gotchas/adopted-ref-divergence]] — the divergence-and-recovery flow.
