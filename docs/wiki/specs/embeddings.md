---
type: spec
description: "Banked, unimplemented dense-vector retrieval design — embed envelope, model.embed tier, recomputable embeddings.db — gated on logged BM25 misses"
created: 2026-06-09
updated: 2026-06-09
sources:
  - "[[memory]]"
  - "[[v1]]"
  - "[[wiki/specs/projection-store]]"
  - "[[wiki/specs/capabilities]]"
status: draft
---

# Embeddings (banked design)

This spec is the **banked** design for dense-vector retrieval in Dome: the
`dome.model-provider.embed/v1` provider envelope, the `model.embed` capability
tier, `embeddings.db` as a new store class (the **recomputable cache**), and
vectors as a third reciprocal-rank-fusion channel in the `dome query` pipeline.

**None of it is implemented.** Implementation proceeds only when the retrieval
miss log (§"The gate") shows a real miss rate that BM25 + link expansion +
recency cannot close — reaffirming [[v1]] decision 4 ("reconsider embeddings
only from concrete work-vault query/packet misses") and [[memory]] decision 1
(BM25-first, vectors evidence-gated). The design is written down now so that
the architectural questions — where vectors live, what cost class they are,
which invariants they must not violate — are settled *before* evidence arrives,
not negotiated under pressure.

The research grounding lives in [[memory]] §"Research grounding": hybrid
retrieval gains are modest at vault scale (~few NDCG points over BM25 under
~10k docs); embedding cost is a non-issue (whole vault ≈ 2.5M tokens
one-time); the gate is architectural honesty and measured need, not dollars.

## `dome.model-provider.embed/v1` envelope

The vault-configured command model provider ([[wiki/specs/capabilities]]
§"model.invoke") gains a third request envelope alongside
`dome.model-provider.request/v1` (single-shot text) and
`dome.model-provider.step/v1` (tool-use step), plus the
`dome.model-provider.probe/v1` health envelope. Same transport: the command
runs from the vault root, reads one JSON object on stdin, writes one JSON
object on stdout, exits 0.

Request on stdin:

```ts
// names indicative
type CommandModelEmbedRequest = {
  schema: "dome.model-provider.embed/v1";
  texts: string[];        // batch; order is significant
  model?: string;         // embedding model id; provider default when absent
  dims?: number;          // requested output dimensionality (e.g. Matryoshka
                          // truncation); provider default when absent
};
```

Response on stdout:

```ts
{
  vectors: number[][];    // one vector per input text, same order, uniform length
  model?: string;         // resolved model id — becomes part of the cache key
  costUsd?: number;       // provider-reported cost; feeds the daily cost cap
}
```

Validation mirrors the existing envelopes (Zod at the model boundary, before
processor code sees the response): `vectors.length === texts.length`, every
vector the same finite length, every entry a finite number, `costUsd` finite
and non-negative when present. A non-zero exit or invalid response is a
provider error, not a vault error: the calling channel degrades (§"Query
integration") rather than failing the surface. Providers that predate the
embed envelope may reject it with a non-zero exit; like `probe-unsupported`,
that means "alive, no dense channel" — never a doctor failure.

The processor-facing handle mirrors `ModelProvider` / `ModelStepProvider` in
`src/engine/core/model-invoke.ts`:

```ts
// names indicative
type ModelEmbedRequest = {
  readonly texts: ReadonlyArray<string>;
  readonly model?: string;
  readonly dims?: number;
  readonly signal: AbortSignal;   // shares the processor invocation signal
};

type ModelEmbedResponse = {
  readonly vectors: ReadonlyArray<Float32Array>;
  readonly model?: string;
  readonly costUsd?: number;
};

type ModelEmbedProvider = (
  request: ModelEmbedRequest,
) => Promise<ModelEmbedResponse>;
```

## `model.embed` capability tier

A new capability tier, parallel to `model.invoke` in every enforcement detail:

```ts
| { kind: "model.embed"; maxDailyCostUsd?: number; modelAllowlist?: string[] }
```

- **Adoption-phase-excluded.** The loader rejects `model.embed` in
  adoption-phase manifests at registration time, exactly as it rejects
  `model.invoke`. Adoption must stay deterministic and offline; embedding is
  garden-/view-phase work.
- **Cost-capped.** `maxDailyCostUsd` caps bundle-level embedding spend per
  local day. The runtime sums provider-reported `costUsd` for the processor's
  extension-id prefix since local midnight, adds the current run's in-memory
  cost, and denies further calls with `model.embed.denied` once the stricter
  of the declared and granted caps is reached. Embedding spend is accounted
  separately from `model.invoke` spend — the two tiers carry independent caps.
- **Model allowlist.** The runtime enforces the intersection of declared and
  granted `modelAllowlist` before any provider call.
- **Ledgered.** Each embed-call attempt is recorded in `capability_uses` with
  `capability = "model.embed"` and the resolved model as the resource when
  known.

When implementation lands, the tier joins the closed capability set in
[[wiki/specs/capabilities]] (declaration schema, grant schema, broker
enforcement, and the tier count there update in lockstep — see
[[wiki/gotchas/substrate-count-drift]]).

## `embeddings.db` — the recomputable cache (a new store class)

Vectors do not go in `projection.db`. They are a **third store class**, named
honestly by what it costs to get the data back:

| Store class | Files | Rebuild cost | Wiped by `dome rebuild` |
| --- | --- | --- | --- |
| Knowledge projection | `projection.db` | CPU — free, deterministic | yes (the wipe *is* the migration) |
| **Recomputable cache** | `embeddings.db` | **dollars + provider availability** | **no** |
| Durable operational state | `answers.db`, `runs.db`, `outbox.db`, quarantine state | not rebuildable — human decisions, audit history, retry state | no |

A projection is hermetically rebuildable: wipe it and deterministic processors
restore it from the adopted commit at CPU cost
([[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]]). Durable operational state
is not rebuildable at all. The embedding cache sits between: every row *can*
be recomputed from adopted markdown — but only by calling a paid,
network-dependent, non-deterministic-across-model-versions provider.
"Rebuildable at dollar cost" is the honest classification, and it dictates
both lifecycle rules: the cache is **never** trusted as truth (it can be
deleted at any time with zero correctness impact), and it is **not** wiped by
projection rebuild (rebuild makes no model calls by design, so wiping would
silently convert a free operation into a paid one). Hiding vectors inside
`projection.db` would have broken one rule or the other; naming the cost class
resolves the fight. Pinned by
[[wiki/invariants/EMBEDDINGS_ARE_A_RECOMPUTABLE_CACHE]].

### File and schema

```
<vault>/.dome/state/embeddings.db   # gitignored with the rest of .dome/state/
```

```sql
CREATE TABLE embeddings (
  content_hash TEXT NOT NULL,     -- sha256 of the embedded text
  model_id     TEXT NOT NULL,     -- resolved embedding model id
  dims         INTEGER NOT NULL,  -- vector length
  vector       BLOB NOT NULL,     -- little-endian Float32Array bytes (dims entries)
  path         TEXT,              -- advisory current anchor; NOT part of identity
  section_id   TEXT,              -- advisory current anchor; NOT part of identity
  written_at   TEXT NOT NULL,     -- ISO-8601
  PRIMARY KEY (content_hash, model_id, dims)
);
```

The key is `(content_hash, model_id, dims)` — **content-addressed**, not
path-addressed. Moving or renaming a page costs nothing (the hash is
unchanged); editing a section orphans the old row and lazily produces a new
one; switching embedding model or dimensionality starts a fresh keyspace
without invalidating anything by hand. Orphaned rows (hashes no longer present
in any adopted section) are cache garbage: a sweep may prune them at any time,
or never — correctness is unaffected either way. `path`/`section_id` are
advisory bookkeeping for inspection and pruning, refreshed on write;
resolution at query time always goes hash-first.

The embedded text for a section is the same string M1's `index-text` puts in
the FTS `body` — breadcrumb-prepended section content (see
[[wiki/specs/projection-store]] §"fts_documents") — so the FTS row and the
vector row describe the same retrieval unit and the content hash can be
computed from either side without re-splitting.

Like `projection.db`, the file is written only by its engine-owned store
module (the SQLite-writing-boundary discipline of
[[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]]); processors never hold a
database handle.

### Population: write-through at the embed boundary, lazy backfill in the garden

There is **no new Effect kind** — the eleven-kind taxonomy stays closed.
Effects route durable consequences; a cache row has none (deleting it changes
nothing), so vectors never travel through effect routing. Instead the
runtime's embed boundary **memoizes**: every capability-checked
`ctx.modelEmbed` call writes its result rows through to `embeddings.db`,
keyed by content hash, the same way the model boundary already records cost
rows as a side effect of `model.invoke`.

Lazy backfill is a garden-phase processor (indicatively
`dome.search.embed-backfill`, declaring `read` + `model.embed` and nothing
else) triggered by the same `document.changed` / `file.created` /
`file.deleted` signals as M1's indexer, plus an optional cron sweep. It reuses
M1's section identity — the same heading-section splitter and
`(path, sectionId)` units as `index-text` — hashes each current section,
batch-embeds the hashes with no cache row, and exits. Properties that follow
from the design:

- **Idempotent and resumable.** Already-cached hashes are skipped at the
  boundary; a crashed or cost-capped run simply leaves more rows for the next
  trigger. Missing rows degrade retrieval, never correctness.
- **Not rebuild-eligible, and doesn't need to be.** The processor makes model
  calls, so projection rebuild never re-runs it
  ([[wiki/specs/projection-store]] §"Rebuild path") — and since
  `embeddings.db` survives rebuild, nothing is lost when rebuild skips it.
- **No durable facts.** It emits no `FactEffect`, no `PatchEffect`, no
  `QuestionEffect` — [[wiki/invariants/MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS]]
  is satisfied trivially, and the cache rows it populates are not facts (no
  processor may read them as such; see the invariant doc).

## Query integration: a third RRF channel

M1's `dome query` pipeline ([[wiki/specs/cli]] §"`dome query`") fuses two
channels with reciprocal-rank fusion (k=60): FTS and one-hop link expansion
over `dome.graph.links_to` facts. Vectors land as a **third channel** in the
same fusion, not a parallel ranking system:

1. The query processor (holding `model.embed`) embeds the query text — one
   provider call, counted against the same daily cost cap.
2. It loads candidate section vectors from `embeddings.db` (hash-joined
   against current FTS rows) and scores them by **brute-force cosine over
   `Float32Array` blobs in TS**. At vault scale this is milliseconds: tens of
   thousands of sections × a few hundred dims is a few tens of millions of
   multiply-adds, far below any indexing threshold.
3. The top-K dense hits enter RRF as a third ranked list, at reduced channel
   weight (tuned at implementation, like the link channel's half weight). The
   fused contribution lands as `fusion`-kind ranking signals ("semantically
   similar"), so a dense-only hit can enter the candidate set but cannot
   outrank a direct strong FTS hit for an exact-term query on fusion alone.

**Explicitly NO sqlite-vec** (or any SQLite vector extension). Bun's built-in
`bun:sqlite` links Apple's system SQLite on macOS, which ships with extension
loading disabled; loading sqlite-vec requires a Homebrew-SQLite install plus a
custom-dylib (`Database.setCustomSQLite`) workaround on every Mac. Dome's
primary dogfood platform is macOS; an install-time wart to accelerate a
brute-force scan that is already milliseconds at vault scale is a bad trade.
Revisit only if vault scale makes brute force measurably slow — and then as an
in-process ANN structure first, not a native extension.

**Graceful degradation to pure BM25.** The dense channel contributes nothing
— and the other channels are exactly M1's output — whenever any of these hold:
no model provider configured; `model.embed` not declared/granted; the
query-time embed call fails or is cost-capped; the cache has no rows for the
candidate set. Per-section misses degrade per-section: an un-backfilled
section simply cannot surface *via the dense channel* while remaining fully
reachable via FTS and links. Retrieval quality is the only thing at stake;
results never error and never block on the cache.

## The gate: the retrieval miss log

Implementation of everything above proceeds **only when the retrieval miss
log shows a real miss rate** — concrete recall failures that BM25++
demonstrably did not cover. This is [[memory]] decision 1 and [[v1]] decision
4 made operational.

The convention:

- **File:** `retrieval-misses.md` at the vault root (a plain markdown page,
  human- and agent-appendable, adopted like any other page).
- **Who writes:** foreground agents (and the user), at the moment a
  `dome query` or `dome export-context` packet missed something that was later
  found by hand. The vault-root AGENTS.md already instructs agents to "note
  the miss"; this names the file and the line shape.
- **Format:** one dated line per miss:

  ```markdown
  - YYYY-MM-DD query: "<text>" missed: [[page]] found-via: <how>
  ```

  Example:

  ```markdown
  - 2026-06-12 query: "auth retro decisions" missed: [[wiki/syntheses/auth-retro]] found-via: manual grep for "retro"
  ```

The log is the evidence surface: misses where the query's terms simply don't
appear on the missed page (vocabulary mismatch — the one failure class dense
vectors actually fix) justify building this spec; misses that trace to
ranking, recency, or indexing bugs justify fixing M1 instead. A handful of
entries is anecdote; a recurring vocabulary-mismatch pattern is the gate
opening.

## Related

- [[memory]] — the memory-quality plan; §"M6" banked this design; §"Research grounding" carries the evidence
- [[v1]] — decision 4: embeddings deferred pending concrete query/packet misses
- [[wiki/invariants/EMBEDDINGS_ARE_A_RECOMPUTABLE_CACHE]] — the named invariant this spec introduces (tier: deferred)
- [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]] — what `embeddings.db` must not weaken
- [[wiki/invariants/MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS]] — why vectors are not facts
- [[wiki/specs/projection-store]] — the adjacent store classes and rebuild semantics
- [[wiki/specs/capabilities]] — `model.invoke`, the tier `model.embed` parallels
- [[wiki/specs/cli]] §"`dome query`" — the RRF pipeline the dense channel joins
