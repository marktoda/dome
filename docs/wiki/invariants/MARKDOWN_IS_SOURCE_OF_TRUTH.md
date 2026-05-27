---
type: invariant
created: 2026-05-27
updated: 2026-05-27
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
tier: axiom
---

# MARKDOWN_IS_SOURCE_OF_TRUTH

**Tier:** Axiom — non-disable-able.

**Statement:** The markdown files in the vault are the canonical state. Any derived data structure — the projection store at `<vault>/.dome/state/projection.db`, the run ledger at `<vault>/.dome/state/runs.db`, the outbox at `<vault>/.dome/state/outbox.db`, the committed projections `index.md` and `log.md`, in-memory caches inside processors — is reconstructable from the markdown alone.

**Why:** No vendor lock-in; the vault remains fully usable in any markdown editor even if Dome disappears. Native writes from Obsidian, vim, the agent's `Write`, or a `git pull` are tolerated because markdown stays canonical — the watcher catches them, the engine constructs Proposals from the resulting commit range, adoption runs, projections update. Sync mechanisms (v1+) can be markdown-native without coupling to Dome's runtime.

**Structural enforcement:** Nothing canonical lives in `.dome/state/`. The three SQLite files there (`projection.db`, `runs.db`, `outbox.db`) are derived; `dome rebuild` reconstructs `projection.db` from the adopted commit + the loaded processor set per [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]]. The run ledger and outbox carry data git doesn't (failed-run forensics, capability uses, external-action retries) — those tables are not full-rebuild candidates, but their loss is operationally recoverable (engine commits still carry the four Dome-* trailers; outbox entries can be replayed against external systems via `dome doctor --outbox-replay`).

**The explicit "derived" zone under `.dome/`:** `.dome/state/` holds derived operational state, not canonical knowledge. It is gitignored by default. Deleting it does not lose user content; deleting `projection.db` triggers automatic rebuild on the next `openVault`; deleting `runs.db` loses historical run audit; deleting `outbox.db` loses pending external actions. The `.dome/config.yaml`, `.dome/page-types.yaml`, and `.dome/extensions/<bundle>/` paths are part of the vault's identity and ARE committed. The "what has been adopted" cursor is `refs/dome/adopted/<branch>` (per [[wiki/invariants/ADOPTED_REF_IS_SEMANTIC_CURSOR]]) — a first-class git ref, not a `.dome/state/` file. The distinction is documented in [[wiki/specs/vault-layout]] §"Derived operational state under `.dome/`".

**Counter-example:** A plugin stores entity relationships in `.dome/state/relations.sqlite` and serves queries from it without re-reading markdown. Native writes from Obsidian update markdown but not the parallel SQLite; queries return stale results. The fix: treat the SQLite as a projection scoped under the plugin's `graph.write` namespace inside `projection.db`; per [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]] and [[wiki/specs/projection-store]] §"Rebuild path", projections rebuild on every Proposal adoption (the cache key `(adoptedCommit × extensionSetHash × processorVersionsHash)` invalidates).

**Test guarantee:** `tests/invariants/markdown-is-source-of-truth.test.ts` — seeds a fixture vault, runs `dome sync`, snapshots the projection.db contents, deletes `.dome/state/projection.db`, runs `dome rebuild`, asserts the rebuilt tables match the snapshot byte-for-byte (modulo `written_at` timestamps which are normalized in the comparison). The test exercises the rebuild path per [[wiki/specs/projection-store]] §"Rebuild path".

**Related:**
- [[wiki/specs/vault-layout]]
- [[wiki/specs/projection-store]] §"Rebuild path"
- [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]]
- [[wiki/invariants/ADOPTED_REF_IS_SEMANTIC_CURSOR]]
- [[wiki/concepts/brain-companion]]
- [[wiki/gotchas/out-of-band-vault-edits]]
- [[wiki/gotchas/projection-schema-skew]]
