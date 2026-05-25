---
type: gotcha
created: 2026-05-25
updated: 2026-05-25
severity: medium
first_observed: 2026-05-25
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
---

# Multi-page partial write

**Symptom:** An ingest operation that should update 7 pages updates 3, then fails (process killed, disk full, harness terminated mid-operation, LLM timeout). The vault is now in a partially-updated state — some pages reflect the new claim, others don't. Cross-references are broken.

**Root cause:** A single ingest invocation produces multiple `writeDocument` Tool calls. These calls happen sequentially. If the process dies between calls, the partial state is on disk.

**Structural mitigation (v0.5):** **Collect-and-apply with git rollback.**

- The agent loop accumulates proposed writes in memory (an Effect array) without committing to disk until the workflow signals completion.
- On signal, the SDK applies all writes in a single batch. If any individual write fails (invariant violation, filesystem error), the batch is *not* atomic at the filesystem level — but the vault is git-backed, so the user runs `git reset --hard HEAD` to roll back to the last clean state, or `git stash` to inspect.
- A `log.md` entry is appended at workflow start (verb: `ingest-started`) and at workflow end (verb: `ingest-complete`). The presence of a `-started` without a corresponding `-complete` in the recent log is a flag for `dome doctor` — it indicates an interrupted workflow.

This is not transactional in the database sense. It is *recoverable* in the git sense, which is good enough for personal-vault use cases. v1+ multi-device sync may require stronger atomicity; that's a v1+ concern.

**Specific scenarios:**

- **Harness killed mid-batch.** The user closes Claude Code while ingest is running. The SDK's accumulated Effects never flush. Outcome: zero pages updated, raw file remains in `inbox/raw/`. Next intake-hook invocation re-processes it.
- **Filesystem error mid-batch.** Disk full. The first 3 writes succeed; the 4th fails with ENOSPC. Outcome: 3 pages partially updated. `dome doctor` flags the interrupted workflow. User frees space, runs `git reset --hard HEAD` to roll back, then re-runs ingest.
- **Invariant violation discovered mid-batch.** The 4th write would violate `WIKILINKS_ARE_FULLPATH` (a short-form link in the proposed body). The SDK returns the error to the agent BEFORE any writes are committed (validation runs over the full Effect array first; commit only happens if all writes validate). The agent retries with corrected links.

**Operational notes:**

- The "accumulate then apply" pattern means workflows can be aborted at any point before the apply step without consequence. This is the agent's "save point."
- Once the apply step starts, it runs to completion or hits a hard error. There is no half-applied state from the SDK's side (modulo OS-level filesystem oddities, which git handles).
- For workflows that need streaming (e.g., a long research session updating many pages over time), the SDK provides a `commit_batch()` Tool the workflow can call to apply accumulated effects and start a new batch. This is rarely needed in v0.5.

**Related:**
- [[wiki/specs/sdk-surface]] §"Tool" (Effect arrays)
- [[wiki/invariants/EVERY_WRITE_IS_LOGGED]]
- [[wiki/gotchas/concurrent-harness-write]] (sister failure mode)
