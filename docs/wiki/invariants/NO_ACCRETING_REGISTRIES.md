---
type: invariant
created: 2026-06-11
updated: 2026-07-11
sources:
  - "[[cohesive/brainstorms/2026-06-11-dome-v1-plan]]"
description: "No vault file's contract is append-forever: indexes render from description: frontmatter, activity is git history; grants fence log.md/indexes"
enforced_by:
  - tests/invariants/no-accreting-registries.test.ts
  - tests/extensions/dome.agent/grant-aware-tools.test.ts
  - tests/extensions/render-index.test.ts
  - tests/cli/commands/log.test.ts
tier: shipped-default
---

# NO_ACCRETING_REGISTRIES

**Tier:** Shipped default — the grant exclusions live in shipped-default vault config and the first-party manifests; a vault owner who really wants an append-forever file can grant one, but no first-party surface will maintain it.

**Statement:** Every central vault artifact is either source-of-truth markdown a human curates, or a deterministic render from per-item sources. No file's maintenance contract is "agents append entries forever." The index files are renders from per-page `description:` frontmatter (`dome.markdown.render-index` rewrites the `dome.markdown:index-catalog` generated block; per-category shards render under `meta/` while `index.md` stays at the vault root); the activity log is git history (engine commit bodies carry the patch narrative, surfaced by `dome log`); `log.md` is frozen. Semantic gardening uses current markdown plus proposal decisions as memory and owns no cursor ledger or queue.

**Why:** An accreting registry is a file that grows monotonically because keeping it current is somebody's standing chore — and in Dome the "somebody" is a model processor burning tokens to hand-maintain what a deterministic render or git itself already knows. Both v1 instances failed the same way: the hand-edited `index.md` grew past what model tooling could safely rewrite, and `log.md` re-narrated information the run ledger and engine commits already carried. The fix is structural, not editorial: derive the artifact (index ← `description:` frontmatter; activity ← commit bodies + run ledger) so the failure mode ceases to exist instead of being groomed. Pinning the rule keeps the next bookkeeping file from sneaking in.

**Structural enforcement:**

1. **Index files are renders.** `dome.markdown.render-index` (garden; cron `15 5 * * *` plus wiki create/delete signals) compiles `index.md` (vault root) and `meta/index-<category>(-N).md` shards from `dome.page.description` facts projected off page frontmatter. Owner prose outside the `dome.markdown:index-catalog` block survives; pages opt out with `index: false`; an explicitly empty `index_categories: {}` config disables rendering for a vault whose index stays curated. No model edits an index file: the renderer is deterministic, every model-class processor is fenced out, and the only other covering writers are the deterministic source-preserving hygiene passes (`dome.markdown.repair-wikilinks`, `normalize-frontmatter`, `refresh-updated`, and the wikilink validators), whose `**/*.md` grants are retained by design — a page rename must not strand broken links in a render or in frozen history. Beyond those generic hygiene passes, the index files' only legitimate patcher is `render-index`.
2. **The activity log is git.** The engine commit body carries the PatchEffect's sanitized `reason` (the agent's final message feeds it), and `dome log` joins the `Dome-*` trailers with the run ledger to render recent activity. `log.md` is frozen history — nothing appends to it; no charter instructs an agent to.
3. **Grant fences at three layers.** The `dome.agent` manifest `patch.auto` grants and the shipped-default vault-config `patch.auto` grant exclude `log.md` and the index files (read stays granted — agents still orient from them); the broker denies any stray PatchEffect. Below the broker, the grant-aware agent tools (`INGEST_WRITABLE_PATHS` / `CONSOLIDATE_WRITABLE_PATHS`) deny the write at tool time, so a confused model self-corrects mid-loop instead of poisoning an all-or-nothing patch verdict.
4. **Operational memory stays in the operational stores that own it.** Semantic-gardening decisions live in `proposals.db`; run outcomes live in `runs.db`; neither is mirrored into an append-only markdown ledger. Knowledge lands in wiki pages where future gardening can rework it.

**Counter-example:** A new extension wants a "decisions registry": every time an agent makes a routing choice, append one line to `decisions.md` so there's a browsable record. That is `log.md` again — the record already exists in the engine commit body and the run ledger, and the file's only maintenance contract is unbounded appends. The right design: if the per-decision narrative matters, it rides the patch `reason` (and thus the commit body, queryable via `dome log --grep`); if a browsable surface matters, render it deterministically from per-item sources the way the index catalog is rendered from `description:` frontmatter.

**Test guarantee:** `tests/invariants/no-accreting-registries.test.ts` is the structural fence: no module in the `dome.agent` bundle lib instructs log.md appends or index-file edits; across every first-party manifest, no processor holding `model.invoke` holds `patch.auto` covering `log.md` or the index files, no processor of any class names `log.md` as a targeted patch path, and the only processor that names index files as targeted patch paths is `dome.markdown.render-index`; the `dome.agent` manifest, the shipped-default vault-config grant, and the bundle-local writable-path mirrors all exclude `log.md` and index files from `patch.auto`. Behavioral coverage: `tests/extensions/dome.agent/grant-aware-tools.test.ts` (tool-time denial without a recorded edit), `tests/extensions/render-index.test.ts` (deterministic index render, opt-outs, prose preservation), `tests/cli/commands/log.test.ts` (`dome log` as the activity surface).

**Related:**
- [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]] — renders are projections of markdown, not rivals to it
- [[wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS]] — the provenance layer `dome log` reads
- [[wiki/invariants/LOG_IS_APPEND_ONLY]] — the superseded `log.md` projection plan; frozen in favor of this invariant
- [[wiki/specs/vault-layout]] §"`index.md`" and §"`log.md`"
- [[wiki/specs/cli]] §"`dome log`"
