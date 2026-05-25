---
type: invariant
created: 2026-05-25
updated: 2026-05-25
sources: ["[[raw/original-architecture]]", "[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
tier: axiom
---

# LOG_IS_APPEND_ONLY

**Tier:** Axiom — non-disable-able.

**Statement:** `<vault>/log.md` is mutated only by the `appendLog` Tool, which appends a new entry to the end of the file. No other Tool writes to `log.md`. Entries are never modified or deleted in place.

**Why:** The log is the audit trail. Operations on the vault are reconstructable from the log alone. If entries could be rewritten, agent behavior would lose its history-of-record property and trust falls.

**Structural enforcement:** `appendLog(entry)` is the only Tool whose `effects` array contains `{ kind: 'appended-log' }`. It opens `log.md`, seeks to the end, writes the formatted entry, and closes. `writePage` and `moveDocument` explicitly do not accept `log.md` as a target.

**Counter-example:** A "log compaction" plugin decides log.md is too large and rewrites it with summarized entries. Violation. The right design: a separate archival tool that writes a frozen copy to `log-archive/YYYY-MM.md` and starts a fresh log.md — the original is never mutated in place.

**Test guarantee:** `tests/invariants/log-is-append-only.test.ts` — runs a representative ingest workflow, captures post-op log.md byte length, runs more operations, asserts post-op-N log.md starts with pre-op-N content unchanged. Asserts no Tool other than `appendLog` produces an `appended-log` effect.

**Related:**
- [[wiki/specs/sdk-surface]] §"Tool catalog"
- [[wiki/invariants/EVERY_WRITE_IS_LOGGED]]
- [[wiki/matrices/tool-invariant-enforcement]]
