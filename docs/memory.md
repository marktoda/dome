---
type: plan
tags:
  - memory
  - roadmap
  - retrieval
  - ranking
created: 2026-06-09
updated: 2026-06-09
status: plan-of-record
sources:
  - "[[wedge]]"
  - "[[v1]]"
  - "[[wiki/specs/autonomous-agents]]"
  - "[[wiki/specs/page-schema]]"
---

# Memory-quality plan — conventions and ranking, not new primitives

Plan of record as of 2026-06-09, following [[wedge]] (all five wedge phases
shipped). Five mechanisms that make the vault's memory *improve over time*:
hybrid-ish retrieval, page supersession, a core-memory page, dismissal-derived
discounting, and deterministic preference promotion — plus a banked,
evidence-gated design for embeddings.

## The design finding

Four of the five mechanisms decompose into (a) a markdown convention, (b) a
deterministic processor deriving **rebuildable** facts, and (c) model judgment
confined to proposing — i.e., they fit the four-concept core with **zero
invariant amendments**. Only vector embeddings fight the architecture (model-
derived state that cannot be recomputed for free), and that fight is resolved
by *naming the cost class* (a recomputable cache, distinct from projections)
rather than by hiding vectors inside `projection.db`. That design is banked as
a spec and gated on measured retrieval misses, reaffirming [[v1]] decision 4.

## Research grounding (2026-06 pass, key evidence)

- **Hybrid retrieval gains are modest at vault scale** (~few NDCG points over
  BM25 under ~10k docs); heading-section chunking with breadcrumb context is
  the consensus win regardless of vectors; RRF (k=60) beats weighted score
  mixing when no reranker exists. SuperLocalMemory V3 (zero-LLM, LoCoMo-
  benchmarked) weights its **entity-graph channel highest** — wikilink
  expansion carries real signal at small scale.
- **Salience without an LLM per item**: exponential recency decay keyed to
  last access (generative agents, 0.995^hours) + explicit counters; Wilson
  95% lower bound × 90-day freshness decay (Open Second Brain) is the best
  shipped deterministic confidence formula.
- **Supersession**: the ADR convention (immutable records, one status flip +
  forward link) is the only markdown supersession pattern with a proven
  maintenance record. Block-level supersession is unshipped anywhere; schemas
  beyond ~4–6 frontmatter fields get abandoned.
- **Preference promotion**: Open Second Brain's dream pass is the only fully
  documented deterministic design — 3 same-sign signals → candidate; 14-day
  evidence window; applied ≥ 10 ∧ violated = 0 → high confidence; quarantine
  when violated ≥ applied; signals are *explicitly marked at write time*,
  keeping the algorithm LLM-free.
- **Dismissal learning**: LinkedIn impression discounting (ImpCount ×
  LastSeen decay — demotion self-heals) + Gmail's asymmetric thresholds
  ("buried something important" engineered to be the rare error). No shipped
  system kills an item on N dismissals alone.
- **Embeddings cost is a non-issue** (voyage-4-lite: 200M free tokens/month;
  whole vault ≈ 2.5M tokens one-time). The gate is architectural honesty and
  measured need, not dollars. sqlite-vec works under Bun but needs a
  Homebrew-SQLite workaround on macOS; at vault scale, brute-force cosine
  over Float32Array blobs in TS is milliseconds — no extension needed.

## Phases

Each phase: spec edit first, implementation, tests; full suite green except
the four pre-existing `v1-dogfood-preflight` failures. M1 → (M2 ∥ M3) →
(M4 ∥ M6) → M5.

### M1 — BM25++ retrieval

- **Section-level indexing**: `dome.search.index-text` emits one
  SearchDocument per heading section (target 200–512 tokens, sub-split long
  sections, heading-path breadcrumb prepended to the indexed body; page-level
  metadata preserved). Projection schema change → hash bump → rebuild is the
  migration, by design.
- **Link expansion + RRF**: query-time one-hop expansion over
  `dome.graph.links_to` facts, fused with FTS results via reciprocal-rank
  fusion (k=60) in the existing TS ranking layer.
- **Recency decay**: `score × 0.995^hours-since-lastHumanChangedAt` (floor,
  not cliff) folded into `rankSearchCandidate`, top-N candidates only.
- Acceptance: `dome query` returns section-granular hits with heading
  breadcrumbs; results for entity names (exact-term) do not regress; re-index
  converges (no-op on unchanged content).

### M2 — Page-level supersession (ADR pattern)

- Page-types: `superseded_by: optional` on entity/concept/source/synthesis;
  `status: superseded` is the flip. One flip + one forward link is the whole
  writer burden.
- **Page-status facts**: deterministic adoption processor emits
  `dome.page.status` facts from frontmatter (rebuildable).
- **Lint**: superseded page without a `superseded_by` link → warning; live
  page wikilinking a superseded page outside a `## Superseded`/history
  context → info diagnostic with the forward target as the hint.
- **Ranking**: superseded pages downranked in the composite ranker.
- **Charters**: consolidate proposes status flips instead of rewrites;
  brief/ingest treat superseded content as history. Section-level convention
  (`## Superseded` block moves) documented for mixed pages.
- The warden's "stale claim" flags gain a durable resolution: flip the
  status. Document in [[wiki/specs/task-lifecycle]]'s warden section.

### M3 — Core memory page

- Convention: `core.md` at vault root — identity, active projects, standing
  preferences. Generated-blocks pattern: human prose block + (M5) promoted-
  preferences generated block.
- **Charter injection**: `dome.agent` lib reads `core.md` (path configurable
  via extensionConfig, default `core.md`) and prepends it to ingest /
  consolidate / brief charters when present.
- **Trust via grants**: vaults exclude `core.md` from interactive bundles'
  `patch.auto`; agents propose changes (review patch or question). The only
  auto-writer is M5's answer-mediated handler (the question *was* the
  review). Documented as the canonical grant shape.
- **Size lint**: deterministic warning when core.md exceeds the budget
  (~6,000 chars) — it must stay an always-loadable block, not a junk drawer.
- `dome init` scaffolds a commented skeleton.

### M4 — Dismissal-derived impression discounting

- Deterministic garden processor derives, per open-loop item (anchor
  identity): **impressions** = distinct dailies whose generated open-loops
  block carried the anchor; **action** = origin-thread `lastHumanChangedAt`;
  emits `dome.attention.discount` facts (rebuildable — derived from markdown
  + git only).
- Formula: LinkedIn-style `discount = f(impressionCount, daysSinceLastShown)`
  with LastSeen recovery (demotion self-heals when not shown). Asymmetry by
  construction: discounting **compresses, never deletes**; items carrying a
  due date (📅) or top priority (🔺) are exempt.
- Consumers: open-loop ranking (carry-forward / today / prep) demotes
  discounted items; the brief charter receives discount context ("surfaced
  6×, untouched — compress to one stale-loops line or raise a question").

### M5 — Preference promotion (deterministic dream pass)

Specced at [[wiki/specs/preferences]] (normative).

- **Signals in markdown**: `preferences/signals.md` — dated, signed lines
  (`- 2026-06-09 + filing:: meeting notes go under notes/, not entities/
  (source: [[...]])`). Charters and the foreground contract write a signal
  when the user corrects agent behavior; the two git-derived signals (human
  revert of an engine patch; post-ingest file move) are banked as follow-up —
  v1 signals are explicit at write time.
- **Counters as facts**: deterministic processor tallies same-sign signals
  per topic (rebuildable).
- **Promotion**: ≥3 same-sign signals within 30 days → QuestionEffect
  (idempotent per topic) proposing the rule with the evidence list;
  confidence = Wilson 95% lower bound × 90-day freshness. On approval, the
  answer handler patches the rule into core.md's generated preferences block
  (the sole auto-write path to core.md). Rebuttal: ≥3 opposite-sign →
  retire; quarantine when violated ≥ applied.

### M6 — Banked embeddings design (spec-only)

Specced at [[wiki/specs/embeddings]]; invariant drafted at
[[wiki/invariants/EMBEDDINGS_ARE_A_RECOMPUTABLE_CACHE]] (`tier: deferred`).

- Spec page: `dome.model-provider.embed/v1` envelope; `model.embed`
  capability (cost-capped, adoption-excluded); `embeddings.db` as a **new
  store class — recomputable cache** (content-hash × model-id keys,
  gitignored, survives rebuild, lazy backfill, retrieval degrades to BM25
  when rows missing); brute-force TS cosine, no sqlite extension; RRF fusion
  into the M1 pipeline. Invariant doc drafted at `tier: deferred`.
- **The gate**: a documented retrieval miss-log convention
  (`retrieval-misses.md`; foreground agents append when a query/packet missed
  something later found by hand). Implementation proceeds when the log shows
  a real miss rate.

## Vault rollout (after merge)

`dome init --refresh-config` fills only **missing** grant keys for enabled
first-party bundles — it never merges new entries into a grant list the vault
already carries (grant lists are user-owned config; auto-merging is too
risky). An existing vault therefore applies the grant edits below by hand in
`.dome/config.yaml`. Until they land, `dome doctor` raises one
`capability.grant-entry-missing` warning per gap, naming the exact YAML to
add (`capabilityGrantEntryFindings` in `src/engine/host/health.ts` is the
canonical probe list — keep this section and that table in lockstep).

**Exact grant edits:**

1. `extensions.dome.daily.grant.graph.write` — add `"dome.attention.*"`
   (M4: `dome.daily.attention-discount`'s dismissal-derived discount facts;
   without it the broker drops them and stale loops are never demoted).
2. `extensions.dome.agent.grant.read` — add `"core.md"` (M3: core-memory
   injection into ingest / consolidate / brief task turns).
3. `extensions.dome.agent.grant.read` — add `"preferences/signals.md"`
   (M5: agents read the signals page).
4. `extensions.dome.agent.grant.patch.auto` — add `"preferences/signals.md"`
   (M5: validated signal-line appends).
5. `extensions.dome.agent.grant.graph.write` — add `"dome.preference.*"`
   (M5: the deterministic counter's `dome.preference.topic` facts).
6. The per-processor replacement stanza for the single auto-writer (M5 —
   memory decision 4; without it owner-approved promotions cannot be written
   to `core.md`):

   ```yaml
   extensions:
     dome.agent:
       processors:
         dome.agent.preference-promotion-answer:
           grant:
             read:
               - "core.md"
               - "preferences/signals.md"
             patch.auto:
               - "core.md"
               - "preferences/signals.md"
   ```

7. `extensions.dome.markdown.grant.read` — add `"core.md"` (M3: the
   `core-size` lint's effective read scope is `["core.md"] ∩ grant`; a
   markdown read scope narrowed to `wiki/**` silently kills the lint).
8. `extensions.dome.markdown.grant.graph.write` — add `"dome.page.*"` (M2:
   `page-status` supersession facts; needed for vaults whose config predates
   the M2 grant).

**Other rollout steps:** seed `core.md` (or let `dome init` scaffold the
first-write-only skeleton); remove the stale `.dome/prompts/` augmentation
section from CLAUDE.md (retired in v1); restart the daemon.
Supersession/status conventions announce themselves via lint.

## Decision ledger

1. **BM25-first, vectors evidence-gated** (reaffirms [[v1]] decision 4, now
   with external evidence and a banked design + explicit miss-log gate).
2. **Embeddings, when built, are a recomputable cache — never a projection**;
   `projection.db` stays hermetically rebuildable.
3. **Supersession is page-level ADR-style**; block-level deferred (no prior
   art, ceremony risk).
4. **core.md is propose-only for interactive agents**; the M5 answer handler
   is its single auto-writer.
5. **Dismissal is implicit** (derived from git/markdown), with self-healing
   recovery and 📅/🔺 exemptions; explicit dismiss affordances may layer on
   later.
6. **Promotion is counter-based** (OSB thresholds adopted: 3/30d candidate,
   Wilson × 90d freshness), never one-shot LLM judgment.
