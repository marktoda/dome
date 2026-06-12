---
type: gotcha
created: 2026-05-25
updated: 2026-06-12
sources:
  - "[[cohesive/brainstorms/2026-05-25-dome-vision]]"
coverage: deferred
description: Concurrent writes from multiple surfaces (sessions, mobile, remote hosts) can overwrite each other; v1 lacks a single merge-boundary policy.
first_observed: 2026-05-25
severity: medium
---

# Concurrent harness write

**Symptom:** Two Claude Code sessions, a future mobile client, or a remote compiler host all try to update the same vault near the same time. Without a single merge boundary, one surface can overwrite or obscure another surface's intended change.

**Root cause:** Dome v1 removed the v0.5 direct Tool write surface. That is the right architectural move, but it shifts concurrency to the Git/proposal boundary: clients produce commits, the compiler host observes branch movement, processors emit effects, and the engine applies closure commits. A single local compiler host is coherent; multiple writers across devices or hosts need an explicit queue/merge policy.

**Structural mitigation:** **Git-native proposals plus a future merge queue.**

- The current v1 write path is Git-native: the user or agent edits files, commits, and `dome serve`/`dome sync` adopts the branch head. There is no `writeDocument`/`expected_mtime` contract in v1.
- Processor-generated mutations are PatchEffects routed through the engine. They apply as adoption/garden sub-proposals and closure commits, so engine writes are ledgered and capability-checked.
- A future multi-surface server should own a merge queue: incoming client commits become proposals, engine patches apply on top of the current adopted head, conflicts are resolved explicitly, and only accepted heads advance the shared branch.
- Local same-repo concurrent sessions should be treated like normal Git concurrency: commit, pull/rebase/merge, resolve conflicts, then let Dome adopt the resulting branch state.

This shape keeps the conflict boundary at the same level as the durability boundary. File mtimes are not stable enough for the v1 architecture: they do not compose across Git remotes, server queues, mobile clients, or engine closure commits. Commit ancestry does.

**Specific scenarios:**

- **Two ingests of related content.** Two agents both update `wiki/entities/danny.md`. In the current local workflow, Git conflict detection is the guardrail if both sessions commit/pull. In the future server workflow, both commits enter the queue and the loser rebases or becomes an explicit conflict question.
- **Engine patch on top of user edits.** A processor emits a PatchEffect while the user keeps editing. The engine applies against the adopted/proposal candidate, not arbitrary working-tree state; user work remains visible in Git and can be resubmitted if it was not part of the adopted proposal.
- **Mobile voice capture while laptop is active.** The mobile client should not push directly to the shared branch. It should submit a commit/proposal to the server queue so the laptop compiler host, mobile app, and engine closure commits share one ordering rule.

**Operational notes:**

- The v1 local path deliberately avoids per-page locks. It relies on Git commits, branch ancestry, and the adopted ref as semantic cursor.
- The future server path should make conflict state visible as questions or queue items, not silent last-write-wins behavior.
- A multi-surface implementation should be tested with high-level harness scenarios: two competing commits, engine patch plus user patch, remote fast-forward, remote non-fast-forward, and conflict question recovery.

**v1+ sync notes:**

Concurrent writes across devices are the forcing function for the merge queue. The UI can differ by device, but the ordering rule should not: every surface submits against an explicit base and the server either fast-forwards, rebases, asks, or rejects.

**Related:**
- [[wiki/specs/harnesses]]
- [[wiki/specs/adoption]]
- [[wiki/gotchas/multi-page-partial-write]]
- [[wiki/gotchas/out-of-band-vault-edits]]
