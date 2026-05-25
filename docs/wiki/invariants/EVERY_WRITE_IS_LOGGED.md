---
type: invariant
created: 2026-05-25
updated: 2026-05-25
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
tier: shipped-default
---

# EVERY_WRITE_IS_LOGGED

**Tier:** Shipped default — enabled in every vault; can be disabled in `.dome/config.yaml` for privacy-focused vaults that don't want detailed audit logging.

**Statement:** Every page mutation produces an `appendLog` call within the same Tool invocation. The mutating Tools (`writePage`, `moveDocument`, plus any plugin-registered Tools that mutate the vault) all emit a log entry as part of their Effect array.

**Why:** Combined with `LOG_IS_APPEND_ONLY`, this gives the vault a complete audit trail. Any change to the wiki is recoverable in `log.md`. Combined with the vault being git-backed, `git revert` is a viable universal undo because the log entry tells the user what to revert.

**Structural enforcement:** Mutating Tools structurally include an `appendLog` step in their implementation; the Effect array returned to the caller contains both the mutation Effect and the log-append Effect. The hook dispatcher derives `log.appended` events from the log-append Effect for any hook that wants to observe.

**Counter-example (when enabled):** A plugin adds a `bulkUpdate` Tool that updates 100 pages in one call but writes a single summary log entry rather than 100 per-page entries. This is a borderline case: if the summary captures the full diff and is human-reviewable, it satisfies the invariant. If the summary loses detail (e.g., just "updated 100 pages"), it violates the spirit. The right design for bulk operations: one log entry per logical mutation, with bulk operations producing N log entries in chronological order.

**Test guarantee:** `tests/invariants/every-write-is-logged.test.ts` — for each mutating Tool, invokes it on a fixture vault, captures the returned Effect array, asserts at least one Effect is `kind: 'appended-log'`. Asserts the log entry references the mutated path.

**Related:**
- [[wiki/invariants/LOG_IS_APPEND_ONLY]]
- [[wiki/specs/sdk-surface]] §"Tool catalog"
- [[wiki/matrices/tool-invariant-enforcement]]
