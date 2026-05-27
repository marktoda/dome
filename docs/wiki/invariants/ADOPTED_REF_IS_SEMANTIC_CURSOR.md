---
type: invariant
created: 2026-05-27
updated: 2026-05-27
sources: ["[[cohesive/delta-ledgers/2026-05-27-phase-1-3-adopted-ref-and-patch-trailers]]"]
tier: axiom
coverage: off-matrix
enforced_at: src/adoption.ts
---

# ADOPTED_REF_IS_SEMANTIC_CURSOR

**Tier:** Axiom — non-disable-able.

**Statement:** `refs/dome/adopted/<branch>` points to the latest commit Dome has fully compiled and considers safe for trusted semantic queries against the named branch. The engine advances it only after `dome sync` completes without blocking diagnostics. Until the ref exists for a branch, `dome status` reports adoption as "uninitialized" and the first `dome sync` initializes it.

**Why:** Pre-rewrite, the closest analogue was `.dome/state/last-reconciled-sha.txt` — a derived per-machine file. The file could be deleted, corrupted, or out of sync with reality without `git log` showing anything; the substrate had no first-class "trusted semantic state" cursor that other tools could query. Moving the cursor to a git ref means:

- **Crash recovery** is derivable from git alone. `git show-ref refs/dome/adopted/main` is authoritative; the prior `.dome/state/` file's existence and freshness no longer matter.
- **Divergence detection** is structural. A force-push, hard-reset, or rebase that rewrites HEAD's history is detectable by checking whether `adopted` is an ancestor of `HEAD`; the prior file-based cursor could not surface this.
- **"What's queued for adoption"** is a single git query: `git log refs/dome/adopted/<branch>..HEAD`. The prior cursor required reading the file, comparing to HEAD, and walking commits manually in user code.
- **Future hosted merge-queue semantics** (the `HOSTED_MQ_IS_ADMISSION_POLICY` framing in `docs/v1.md` §3.3 + §21) become reachable without re-plumbing the cursor shape; the ref is already in the right form.

**Structural enforcement:** Off-matrix. The advance-ref step lives at the `setAdoptedRef` boundary in `src/adoption.ts` — the single chokepoint. Fast-forward-only by default: refuses to advance if `sha` is not a descendant of the current ref value; the `forceAdvance: true` opt-out is explicit and surfaces through the `dome sync --force-advance` CLI flag. The `getAdoptedRef` reader is the symmetric companion; both are re-exported from `@dome/sdk` core for consumer use.

**Counter-example (what this invariant rules out):** A Dome installation that reports its "trusted state" via `.dome/state/last-reconciled-sha.txt` alone — the file lives outside git, can drift from reality, and gives no structural signal of divergence. The post-rewrite substrate retires the cursor role of that file (renaming the survivor to `.dome/state/last-reconcile-mtime.txt` for `dome doctor --time-since-reconcile`'s age check) and consolidates the "trusted state" semantics into the git ref.

**Test guarantee:** `tests/invariants/adopted-ref-is-semantic-cursor.test.ts` is the AC3 lockstep file. Following the off-matrix delegating-stub convention (per [[wiki/specs/sdk-surface]] §"Off-matrix lockstep convention"), it imports `tests/integration/sync-advances-adopted-ref.test.ts` — the canonical enforcement test with three cases:

1. **Fresh vault.** `dome sync` initializes `refs/dome/adopted/main` at HEAD; subsequent `dome status` reports no pending and zero divergence.
2. **Source-ahead vault.** User commits land on top of the existing adopted ref; `dome sync` fast-forwards the ref to the new HEAD.
3. **Divergent vault.** HEAD's ancestry no longer contains the prior adopted commit (simulated by `git reset --hard` to an earlier commit and then committing a different change); `dome sync` refuses to advance with a `engine.adoption.blocked` event; `dome sync --force-advance` accepts the new HEAD.

**Related:**

- [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]] — markdown is canonical; the ref is a marker over it.
- [[wiki/invariants/VAULT_IS_GIT_REPO]] — the ref exists *in* the git repo (refusing to open non-git vaults at the door).
- [[wiki/invariants/VAULT_RECONCILES_AFTER_NATIVE_WRITE]] — the reconcile that advances the ref handles the consumer-shell native-write path.
- [[wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS]] — the structural sibling: engine commits between adopted and HEAD are trailer-bearing.
- [[wiki/specs/adoption]] — the adoption substrate this invariant pins.
- [[wiki/gotchas/adopted-ref-divergence]] — the divergence-and-recovery flow.
