---
type: invariant
created: 2026-05-26
updated: 2026-05-26
sources: ["[[cohesive/brainstorms/2026-05-26-dome-compiler-reframe]]"]
tier: axiom
---

# VAULT_RECONCILES_AFTER_NATIVE_WRITE

**Tier:** Axiom — load-bearing for the compiler-boundary contract; cannot be disabled.

**Statement:** Every native filesystem write to the vault (a write that did not go through a Dome Tool — Claude Code's `Write`/`Edit`, vim, Obsidian, the future mobile app's direct `node:fs` use, `git pull`) is eventually observed by Dome's compiler machinery and produces the same downstream effects as a Tool-mediated write would have: hooks fire on appropriate events, `appendLog` records the change, the index updates, and any invariant-enforcement post-hoc behavior (frontmatter validation, wikilink resolution, etc.) runs against the new state.

"Eventually" here means: at most by the time `dome sync` finishes — either when fired by the watcher in a running `dome serve` (sub-second latency under normal load), or when `dome sync` is invoked manually after the daemon was off.

**Why:** This invariant is the integrity story for the *external* leg of [[VISION]] §"Principles" #3 ("Invariants are enforced two ways, by scope"). Inside Dome's dispatcher / hook / tool chain, [[wiki/invariants/HOOKS_CANNOT_BYPASS_TOOLS]] guarantees that hooks call Tools and Tools enforce invariants at the moment of the call. Across the consumer-shell boundary, consumer shells write to the filesystem directly — and `VAULT_RECONCILES_AFTER_NATIVE_WRITE` is what guarantees the vault stays coherent despite those writes not going through Tools at write time. Without this invariant, the compiler-boundary contract collapses: native writes would silently break documented invariants (log gaps, stale index, unflagged frontmatter mismatches, etc.) and no structural backstop would catch them.

**Structural enforcement:** Two layers, mirroring [[wiki/invariants/EVERY_WRITE_IS_LOGGED]]:

1. **Watcher-driven (primary, when `dome serve` is running).** `VaultWatcher` (chokidar over `wiki/`, `inbox/`, `raw/`, `notes/`) fires `vault.out-of-band-edit` events on every native filesystem change. Shipped-default reactive hooks observe these events: `auto-update-index` updates `index.md` if the change affected wiki structure; a watcher-driven `appendLog` hook records the change with `source: 'out-of-band'`; future hooks (frontmatter validation, sensitivity-style classifiers) can register against the same event.
2. **Sync-driven (secondary, fills the daemon-off gap).** `dome sync` runs the adoption state machine per [[wiki/specs/adoption]]: three reconcile phases (inbox / git-diff replay against `refs/dome/adopted/<branch>..HEAD` per [[wiki/invariants/ADOPTED_REF_IS_SEMANTIC_CURSOR]] / scheduled-hook catchup), drainHooks, then atomically advance the adopted ref. The git-diff replay is idempotent and durable — events the watcher missed (because the daemon was off, or because the OS coalesced chokidar events under load) get fired during sync and processed by the same hook chain.

The two-layer design means: while `dome serve` is running, the watcher catches writes promptly. While it's off, drift accumulates as a queue of git-tracked changes — picked up by `dome sync` at next startup, with cost growing linearly with time-since-last-reconcile (see [[wiki/gotchas/daemon-off-while-vault-mutating]]). The vault converges on consistency either way.

**Counter-example (what this prevents):** A user edits `wiki/entities/danny.md` in vim — adding a new wikilink to `[[wiki/entities/maya]]`. The dome serve daemon catches the write, fires `vault.out-of-band-edit`, the `auto-update-index` hook runs, `appendLog` records the change as `out-of-band`. The vault's `index.md` reflects the new link relationship by the time the user opens Claude Code; the agent arrives oriented to current state. Without this invariant, the user's vim edit would leave the index stale until a user-initiated `dome doctor --rebuild-index` ran, which most users would never invoke.

**Test guarantee:** A regression test (proposed alongside the watcher-driven reactive-hook implementation) writes a file directly to the vault filesystem (bypassing Tools), waits for `vault.out-of-band-edit` to fire and be processed, asserts that `index.md` reflects the new content and `log.md` carries a `source: 'out-of-band'` entry. A second test sets aside the daemon, makes a similar write, runs `dome sync`, asserts equivalent end-state.

**Related:**
- [[VISION]] §"Principles" #3 — the two-ways-by-scope framing this invariant participates in.
- [[wiki/invariants/HOOKS_CANNOT_BYPASS_TOOLS]] — the internal-scope twin (Tool-mediated writes; cannot be bypassed within Dome).
- [[wiki/invariants/EVERY_WRITE_IS_LOGGED]] — depends on this invariant's external path for completeness.
- [[wiki/specs/adoption]] — the adoption state machine `dome sync` drives.
- [[wiki/specs/cli]] §"`dome sync`" — the catch-up mechanism.
- [[wiki/gotchas/out-of-band-vault-edits]] — the canonical-path documentation for native writes.
- [[wiki/gotchas/daemon-off-while-vault-mutating]] — the cost-grows-with-time edge case.
