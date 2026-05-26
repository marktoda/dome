---
type: gotcha
created: 2026-05-25
updated: 2026-05-25
severity: medium
coverage: matrix
first_observed: 2026-05-25
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
---

# Concurrent harness write

**Symptom:** Two Claude Code sessions are open in the same vault. Both ingest something at the same time. Both call `writeDocument` to the same target. The second write clobbers the first. The first user's intended update is lost.

**Root cause:** v0.5's SDK is single-process per Vault instance, but nothing prevents multiple instances from running concurrently against the same vault directory. Each MCP server (one per harness session) opens its own Vault instance; neither knows about the other.

**Structural mitigation:** **Caller-supplied optimistic locking via `expected_mtime`.**

- `readDocument` returns the document's filesystem `mtime` as an ISO-8601 string in the returned `Document`. Callers (agent, hook, harness) treat the mtime as a snapshot token alongside the page contents.
- Mutating Tools (`writeDocument`, `moveDocument`, `deleteDocument`) accept an optional `expected_mtime?: string` field. When passed, the Tool re-reads the target's current `mtime` immediately before mutating; on mismatch it returns `Result.err({ kind: 'concurrent-write-conflict', path, expected_mtime, actual_mtime })` and does not write.
- Omitting `expected_mtime` is the v0.5 default and means "last write wins" — no conflict detection. Workflows that ingest from a single-user, single-session vault (the most common v0.5 case) can ignore the field; harnesses that read-then-write through a multi-session vault should pass it.
- The agent receiving the conflict re-reads the page (gaining a fresh `mtime`), integrates the other harness's update, and re-proposes with the new snapshot. The user sees a brief "the page was updated by another session; merging..." in chat.

This shape makes the protection explicit at the call site rather than implicit in the Tool body. The previous "Tool snapshots mtime internally" design was structurally inert — the snapshot and verify happened inside one synchronous Tool call with no real race window. v0.5 ships the call-site-explicit form; the workflow prompts (shipped-default `ingest`, `query`, `lint`) opt out by not threading `expected_mtime`, while harnesses that hold a Document across user turns thread it.

**Specific scenarios:**

- **Two ingests of related content.** User dictates voice-note-A to harness session 1. While session 1 is ingesting, user reads a paper and asks harness session 2 to summarize. Both end up updating `wiki/entities/danny.md`. Session 1 writes first (no conflict; page mtime matches session 1's read). Session 2 attempts second write; mtime has changed; conflict; session 2 re-reads, integrates session 1's update, re-proposes. Final state preserves both updates.
- **Read-modify-write races within a session.** Two Tools in the same session both read and intend to write the same page. The SDK's effect-batching (see [[wiki/gotchas/multi-page-partial-write]]) groups them; the second write inside the batch uses the first write's intermediate state, not stale on-disk state. No conflict within a session.
- **Out-of-band edit between read and write.** Session reads page; user edits in Obsidian; session writes. mtime mismatch; conflict; the agent re-reads (now sees the user's edit), integrates, re-proposes. The user explicitly sees the merge happening.

**Operational notes:**

- The conflict detection is *optimistic* — it doesn't lock the page during the read-modify-write window. This trades off some retry overhead for not needing a coordinated locking service.
- The conflict's failure mode is *visible* (the agent surfaces "merging..." to the user), not silent. Compare to "last write wins" silent overwrites in some sync systems — those are the bad alternative this mitigation prevents.
- For high-conflict workloads (rare in v0.5; common in v1+ multi-device sync), a stronger locking model may be needed. v0.5 ships optimistic locking; v1+ revisits if needed.

**v1+ sync notes:**

Concurrent writes across devices (laptop and phone) are structurally identical to concurrent writes across harness sessions. The same optimistic-locking primitive scales, but the conflict-resolution UI needs care: the user sees the conflict on their phone or laptop and the surfacing must be device-appropriate.

**Related:**
- [[wiki/specs/sdk-surface]] §"Tool catalog" (`writeDocument`)
- [[wiki/gotchas/multi-page-partial-write]]
- [[wiki/gotchas/out-of-band-vault-edits]]
