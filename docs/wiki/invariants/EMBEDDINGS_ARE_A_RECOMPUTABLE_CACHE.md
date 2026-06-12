---
type: invariant
created: 2026-06-09
updated: 2026-06-12
sources:
  - "[[wiki/specs/embeddings]]"
  - "[[memory]]"
coverage: deferred
description: "Deferred: embeddings.db vectors are deletable rank-only cache, never fact sources; planned fences keep them outside rebuild and Effects"
enforced_at_status: deferred
tier: deferred
---

# EMBEDDINGS_ARE_A_RECOMPUTABLE_CACHE

**Tier:** Deferred — banked alongside the [[wiki/specs/embeddings]] design;
becomes a shipped axiom when (and only when) the embedding implementation
lands behind the retrieval-miss-log gate.

**Statement:** Vectors in `<vault>/.dome/state/embeddings.db` never hold
truth, only acceleration. Every row is keyed by content hash and is
re-derivable from adopted markdown plus an embedding-provider call; the cache
may therefore be deleted — in whole or in part, at any time, by anyone — with
**no correctness impact** on any Dome surface. No processor may read embedding
rows as facts: a vector (or a similarity score computed from vectors) may
influence *ranking* of candidates that carry their own SourceRef-backed
provenance, but may never be the basis of a `FactEffect`, a `PatchEffect`, a
`DiagnosticEffect` claim, a `QuestionEffect` premise, or any other durable or
user-visible assertion about the vault.

**Why:** [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]] partitions Dome's
state into durable truth (markdown + git + `answers.db`) and derived state.
Embeddings fit neither existing derived class:
[[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]] guarantees free, deterministic
CPU rebuild, which model-derived vectors cannot honor (rebuild makes no model
calls by design), while durable operational state is not re-derivable at all,
which vectors are — at dollar cost. The honest resolution is a third class,
**recomputable cache**: not wiped by `dome rebuild` (wiping would convert a
free operation into a paid one), and never trusted (because anything that may
silently vanish or go stale against a newer model version must not carry
truth). Both halves of the statement defend the same property: if a deleted or
stale vector could change what Dome asserts — rather than merely how it ranks
— the cache would have become a shadow source of truth that
`projection.db`-style rebuild guarantees do not protect.

**Structural enforcement (planned with implementation):**

1. **Separate file, outside the rebuild path.** Vectors live in
   `embeddings.db`, never in `projection.db`; `dome rebuild` neither reads,
   wipes, nor repopulates it. The projection-rebuild idempotency guarantees
   stay model-call-free.
2. **Write-through at the embed boundary only.** Rows are written by the
   engine-owned store module as memoization of capability-checked
   `ctx.modelEmbed` calls. There is no Effect kind that carries vectors, so no
   processor output can make a vector durable through routing.
3. **No fact channel from vectors.** The embed-backfill garden processor
   declares `read` + `model.embed` only — no `graph.write`, no `patch.*`, no
   `question.ask` — making "vectors as facts" unrepresentable by construction,
   the same manifest-level discipline as
   [[wiki/invariants/MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS]].
4. **Deletion drill.** Deleting `embeddings.db` mid-flight leaves every
   query/view surface returning correct (BM25-degraded) results; the cache
   lazily refills.

**Counter-example:** A "related pages" garden processor computes cosine
similarity between two pages' vectors and emits a
`FactEffect (dome.graph.similar_to, confidence: 0.91)`. The fact lands in
`projection.db.facts`. The user deletes `embeddings.db` (their right — it's a
cache) and runs `dome rebuild`; rebuild re-runs deterministic processors, but
the similarity processor needs vectors that no longer exist and is skipped.
The live projection and the rebuilt projection now disagree — the "fact" was
model-derived state laundered through a cache read. The fix is structural:
similarity may *rank* (a fusion signal at query time, recomputed or skipped on
every call), never *assert*.

**Test guarantee:** Deferred — `tier: deferred` exempts this doc from the AC3
lockstep requirement in `tests/integration/invariant-coverage.test.ts` until
implementation lands. The planned enforcement test
(tests/invariants/embeddings-are-a-recomputable-cache.test.ts) should pin: the
embed-backfill manifest declares no fact/patch/question capabilities; `dome
rebuild` does not touch `embeddings.db`; and query surfaces succeed with the
cache file deleted.

**Related:**
- [[wiki/specs/embeddings]] — the banked design this invariant pins
- [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]] — the CPU-rebuildable class this cache is deliberately not in
- [[wiki/invariants/MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS]] — the sibling rule for transient model judgment
- [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]] — the parent property
- [[memory]] — decision 2: embeddings are a recomputable cache, never a projection
