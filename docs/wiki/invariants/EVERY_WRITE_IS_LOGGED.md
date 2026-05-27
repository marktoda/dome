---
type: invariant
created: 2026-05-25
updated: 2026-05-26
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]", "[[cohesive/brainstorms/2026-05-26-dome-compiler-reframe]]"]
tier: shipped-default
---

# EVERY_WRITE_IS_LOGGED

**Tier:** Shipped default — enabled in every vault; can be disabled in `.dome/config.yaml` for privacy-focused vaults that don't want detailed audit logging.

**Statement:** Every page mutation to the vault produces a `log.md` entry. The invariant has two enforcement paths, matching the compiler-boundary scope distinction in [[VISION]] §"Principles" #3:

1. **Tool-mediated writes (internal path):** Every Dome Tool that mutates the vault (`writeDocument`, `moveDocument`, `deleteDocument`, plus any plugin-registered Tools that mutate) structurally includes an `appendLog` Effect in its returned Effect array. The log entry is emitted within the same Tool invocation as the mutation.

2. **Native writes from consumer shells (external path):** When a consumer shell writes directly to the filesystem — Claude Code's `Write`/`Edit`, vim, Obsidian, the future mobile app's direct SDK use — the `VaultWatcher` detects the change and fires a `vault.out-of-band-edit` event. A shipped-default reactive hook on this event invokes `appendLog` to record the native write, with the source attributed as "out-of-band" so the log entry's provenance is honest about not having been a Tool call. `dome sync` does the same for events the daemon missed while it was off.

The combined effect: a complete audit trail of every change to the vault, regardless of whether the write came from a Tool or a native filesystem operation.

**Why:** Combined with `LOG_IS_APPEND_ONLY`, this gives the vault a complete audit trail. Any change to the wiki is recoverable in `log.md`. Combined with the vault being git-backed, `git revert` is a viable universal undo because the log entry tells the user what to revert. Coverage of native writes is what makes the audit trail trustworthy across the consumer-shell boundary — without watcher-driven logging, Claude Code writes via `Write` would be silent.

**Structural enforcement:** Mutating Tools structurally include an `appendLog` step in their implementation; the Effect array contains both the mutation Effect and the log-append Effect. The hook dispatcher derives `log.appended` events from the log-append Effect for any hook that wants to observe. For the native-write path, the watcher's reactive hook is part of `dome serve`'s shipped-default hook set (and re-runs during `dome sync`'s git-diff replay).

**Counter-example (when enabled):** A plugin adds a `bulkUpdate` Tool that updates 100 pages in one call but writes a single summary log entry rather than 100 per-page entries. This is a borderline case: if the summary captures the full diff and is human-reviewable, it satisfies the invariant. If the summary loses detail (e.g., just "updated 100 pages"), it violates the spirit. The right design for bulk operations: one log entry per logical mutation, with bulk operations producing N log entries in chronological order.

**Test guarantee:** `tests/invariants/every-write-is-logged.test.ts` — for each mutating Tool, invokes it on a fixture vault, captures the returned Effect array, asserts at least one Effect is `kind: 'appended-log'`. Asserts the log entry references the mutated path. For the native-write path, a regression test (proposed alongside the watcher-driven `appendLog` hook implementation) writes a file directly to the vault filesystem, waits for the watcher to fire, and asserts a `log.appended` event with `source: 'out-of-band'` lands in `log.md`.

**Related:**
- [[wiki/invariants/LOG_IS_APPEND_ONLY]]
- [[wiki/invariants/VAULT_RECONCILES_AFTER_NATIVE_WRITE]] — the broader integrity-via-reconciliation story this invariant participates in.
- [[wiki/specs/sdk-surface]] §"Tool catalog"
- [[wiki/matrices/tool-invariant-enforcement]]
- [[wiki/gotchas/out-of-band-vault-edits]] — the watcher-catches-native-writes pattern this invariant's external-path enforcement relies on.
