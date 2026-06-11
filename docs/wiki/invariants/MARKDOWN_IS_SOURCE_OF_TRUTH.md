---
type: invariant
created: 2026-05-27
updated: 2026-06-11
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
enforced_by:
  - tests/harness/scenarios/cli-surface/rebuild-projection.scenario.test.ts
  - tests/harness/scenarios/effect-kinds/snapshot-reads-candidate-not-working-tree.scenario.test.ts
tier: axiom
---

# MARKDOWN_IS_SOURCE_OF_TRUTH

**Tier:** Axiom — non-disable-able.

**Statement:** The markdown files in the vault plus git history are the canonical knowledge state. Derived query structures — especially `<vault>/.dome/state/projection.db` — are reconstructable from the adopted commit plus the loaded deterministic processor set. Operational state such as `<vault>/.dome/state/runs.db` and `<vault>/.dome/state/outbox.db` is persistent audit/recovery state, not canonical knowledge and not fully reconstructable from markdown alone.

**Why:** No vendor lock-in; the vault remains fully usable in any markdown editor even if Dome disappears. Native writes from Obsidian, vim, the agent's `Write`, or a `git pull` are tolerated because markdown stays canonical — the daemon or `dome sync` catches committed branch movement, the engine constructs Proposals from the resulting commit range, adoption runs, projections update. Sync mechanisms (v1+) can be markdown-native without coupling to Dome's runtime.

**Structural enforcement:** Nothing canonical lives in `.dome/state/`. `projection.db` is derived; `dome rebuild` reconstructs it from the adopted commit + the loaded deterministic processor set per [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]]. The run ledger and outbox carry data git doesn't (failed-run forensics, capability uses, external-action retries). Those tables are not full-rebuild candidates, but their loss does not corrupt the knowledge substrate: engine commits still carry the four Dome-* trailers, and pending external actions are operational recovery concerns surfaced through the engine-asks flow.

**The explicit operational zone under `.dome/`:** `.dome/state/` holds derived and operational state, not canonical knowledge. It is gitignored by default. Deleting it does not lose user content; deleting `projection.db` triggers automatic rebuild on the next `openVault`; deleting `runs.db` loses historical run audit; deleting `outbox.db` loses pending external actions. The `.dome/config.yaml`, `.dome/page-types.yaml`, and vault-local `.dome/extensions/<bundle>/` paths are part of the vault's identity and ARE committed. The SDK-shipped first-party bundles live in the SDK package, not in the vault. The "what has been adopted" cursor is `refs/dome/adopted/<branch>` (per [[wiki/invariants/ADOPTED_REF_IS_SEMANTIC_CURSOR]]) — a first-class git ref, not a `.dome/state/` file. The distinction is documented in [[wiki/specs/vault-layout]] §"Derived operational state under `.dome/`".

**Counter-example:** A plugin stores entity relationships in `.dome/state/relations.sqlite` and serves queries from it without re-reading markdown. Native writes from Obsidian update markdown but not the parallel SQLite; queries return stale results. The fix: treat the SQLite as a projection scoped under the plugin's `graph.write` namespace inside `projection.db`; per [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]] and [[wiki/specs/projection-store]] §"Rebuild path", projections rebuild on every Proposal adoption (the cache key `(adoptedCommit × extensionSetHash × processorVersionsHash × capabilityPolicyHash)` invalidates).

**Test guarantee:** `tests/invariants/markdown-is-source-of-truth.test.ts` pins the invariant doc into the AC3 lockstep surface. High-level harness scenarios exercise the operational behavior: committed markdown is adopted, projection rows are rebuilt from adopted state, and operational stores such as the run ledger and outbox are preserved rather than treated as markdown-derived cache.

**Related:**
- [[wiki/specs/vault-layout]]
- [[wiki/specs/projection-store]] §"Rebuild path"
- [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]]
- [[wiki/invariants/ADOPTED_REF_IS_SEMANTIC_CURSOR]]
- [[wiki/concepts/brain-companion]]
- [[wiki/gotchas/out-of-band-vault-edits]]
- [[wiki/gotchas/projection-schema-skew]]
