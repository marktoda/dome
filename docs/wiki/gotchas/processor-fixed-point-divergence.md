---
type: gotcha
created: 2026-05-27
updated: 2026-06-11
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
coverage: off-matrix
description: Adoption loop hits MAX_ITER (100) when processors keep emitting new effects; the Proposal blocks with a fixed-point.divergence diagnostic.
enforced_at: src/engine/core/adopt.ts
enforced_at_status: implemented
first_observed: 2026-05-27 (anticipated; surfaced in v1 design)
severity: medium
---

# Processor fixed-point divergence

**Symptom:** The adoption loop hits `MAX_ITER` (default 100) and the Proposal blocks with `code: "fixed-point.divergence"`. `dome sync` / `dome serve` report the blocked adoption and the diagnostic is visible through `dome inspect diagnostics`.

**Root cause:** Two or more adoption-phase processors emit patches that invalidate each other's reactions. Processor A patches a property; processor B reacts to the property's new state and patches again; processor A re-reacts; the loop cycles. Without a fixed-point cap, the adoption would loop forever.

The most common failure modes:

1. **Processor reads its own output.** Processor A emits a PatchEffect; the patched tree now has signals processor A reacts to; A emits another effect; B reacts to A's new effect; the chain continues. Fix: A's triggers should be specific enough that they don't match A's own emissions.
2. **Non-idempotent emissions.** A processor that emits a slightly different patch each iteration (e.g., timestamps embedded in the patch, random IDs not derived from the input). Fix: idempotency — the same input must produce the same patch.
3. **Conflicting capability scopes.** Two processors with overlapping `patch.auto` paths emit patches that touch each other's claimed regions. Fix: clarify ownership via `owns.path` (or narrow each processor's path scope).

**Structural mitigation:** **Hard iteration cap + diagnostic on cap-hit.**

The cap (default 100, configurable as `engine.max_iterations` in `.dome/config.yaml`) is the structural fence. Hitting it always produces a blocking diagnostic that names:
- The Proposal id.
- The iteration counter at cap.
- The last 3 iterations' effect-emission history.
- The candidate processors involved (those whose patches appeared in multiple iterations).

The diagnostic surfaces via `dome sync` / `dome serve`, `dome inspect diagnostics` (and the deferred `dome inspect recent-processor-divergence` v1.x subject), and the adoption result's diagnostics.

```text
dome sync: blocked main: proposal prop_1748... (1 diagnostic)
  - [block] fixed-point.divergence: adoption loop hit MAX_ITER=100 without convergence.
    Last 3 iterations:
      iter 98: processor=dome.markdown.validate-wikilinks, effect=patch (wiki/entities/danny.md frontmatter)
      iter 99: processor=acme.intake.normalize-aliases, effect=patch (wiki/entities/danny.md frontmatter)
      iter 100: processor=dome.markdown.validate-wikilinks, effect=patch (wiki/entities/danny.md frontmatter)
    Candidate processors: dome.markdown.validate-wikilinks, acme.intake.normalize-aliases
    Recommended actions:
      1. Disable one of the candidate processors temporarily (`.dome/config.yaml`) and re-submit.
      2. Inspect the recent diagnostics via `dome inspect diagnostics --code fixed-point.divergence`.
      3. File an issue with the captured iteration history.
```

**Specific scenarios:**

- **Frontmatter ordering churn.** `dome.markdown.parse` emits a patch normalizing frontmatter order (alphabetical by key); `acme.intake.normalize-aliases` emits a patch updating the `aliases:` field but produces it in a different order. Each invalidates the other's normalization. Fix: `acme.intake` defers to `dome.markdown`'s ordering convention — emits aliases in alphabetical order to begin with.

- **Index rewriting on its own write.** `dome.markdown.render-index` emits patches to `index.md` and the category shards. The patched tree now has those files changed; if the renderer's triggers matched the index files themselves, every render would re-fire it. The trigger is correctly scoped (wiki create/delete signals + cron, NOT the index files), and the render is a fixed point by construction — a matching catalog yields zero effects — but it's the canonical "processor reads its own output" pattern to avoid.

- **Cross-bundle backlink loop.** A third-party bundle `acme.recommendations` adds suggestions to entity pages on `signal:file.created` for `wiki/entities/**`. The suggestion-write fires `signal:file.modified` for the same entity; `dome.links.cross-reference` reacts (looking for new mentions) and emits a patch adding backlinks; the backlink-write re-fires `signal:file.modified`; `acme.recommendations` reacts again. The cap catches this. Fix: scope `acme.recommendations` to fire only on `signal:file.created` (not `modified`).

**Operational notes:**

- The cap is generous (100); legitimate fan-out across an entity-rich vault may reach depths of 10-20. Cap-hits are rare and signal a real problem.
- A user who sees a cap-hit should suspect a recently-installed bundle (third-party processors are the usual culprit) or a recently-changed first-party processor.
- The diagnostic carries enough detail (iteration history, candidate processors) that the issue is reproducible from the report alone.
- Reducing the cap below 30 risks false positives on shipped-default processor sets.

**Related:**
- [[wiki/specs/adoption]] §"MAX_ITER and divergence"
- [[wiki/specs/processors]] §"Idempotency"
- [[wiki/gotchas/processor-idempotency]] — non-idempotent processors are the most common cause
- [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]] — the iteration history is in the ledger
