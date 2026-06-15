---
type: brainstorm
tags:
  - design
  - claims
  - consolidation
  - retrieval
  - health
  - second-brain
created: 2026-06-14
updated: 2026-06-14
status: approved-design
sources:
  - "[[wiki/specs/claims]]"
  - "[[cohesive/brainstorms/2026-06-09-meaning-consolidation-claims-and-sweeper]]"
  - "[[wiki/specs/sweep]]"
  - "[[wiki/specs/autonomous-agents]]"
  - "[[memory]]"
  - "[[VISION]]"
  - "[[wiki/specs/task-lifecycle]]"
---

# Claims as a living fact layer — closing the loop

Approved design, 2026-06-14. Claims were designed (the
[[cohesive/brainstorms/2026-06-09-meaning-consolidation-claims-and-sweeper|2026-06-09 meaning-consolidation brainstorm]])
as the governed **derived layer** — "current entity/project/commitment pages
with per-claim provenance" — the structural device that keeps a page tractable
as it grows. [[VISION]] names the same north star: *the bottleneck is not
capture, it is coherence over time; `dome lint` reports stale claims and
contradictions; no claim without a SourceRef.* This design makes that real by
closing the loop the claims substrate left open.

No new primitive. Every item below is a charter extension, a deterministic
processor, a retrieval render, or a view — over the sealed four-concept core.

## Problem: claims is a loop with three broken links

The claims substrate shipped ([[wiki/specs/claims]]) — grammar, anchoring,
fact extraction — but the loop that would make it *live* is broken at every
link:

1. **Authoring — the layer never gets written.** Nothing in the garden
   *creates* claim lines. The sweep charter only **updates the value of an
   already-existing** `**Key:**` line on supersession; `consolidate` never
   mentions claims; `stamp`/`index` only *recognize* lines a human already
   typed. New information is explicitly routed to **narrative prose**. So a
   growing page accretes prose — the exact failure claims were meant to
   prevent — and the claim layer exists only where a human hand-wrote it. In
   the live work vault, almost no page has claim lines. **The "consolidate as
   the doc grows" promise never fires.**

2. **Retrieval — agents don't get the gist.** Claim facts carry
   `subject: page`, so they flow *generically* into `query`/`export-context`
   as an opaque JSON blob — unlabeled, rendered as raw JSON, low-priority,
   capped, crowded out by other facts. They are **absent entirely** from
   `brief` and `tasks`. The 2026-06-09 doc's own acceptance criterion —
   *"`dome query` for an entity returns its current claims"* — was never
   wired.

3. **Health — the coherence substrate is dormant.** [[memory]] built
   supersession/staleness/decay at the **page** level and on counter-facts,
   and explicitly deferred block/claim-level supersession. Yet claims already
   ship in-place supersession, bi-temporal git history per anchor, and a
   contradiction substrate — and only the warden's *same-page* key-collision
   pre-filter uses any of it. Per-fact staleness, "what did I believe in
   March," and cross-page contradiction are all latent and unused.

The cheap, safe wins (retrieval, health probes) are worth little until the
layer is populated; populating it (Link 1) is the part with real quality risk
(cf. the v1 plan's mem0 cautionary tale: unsupervised fact extraction yields
mostly junk). The design treats all three as one loop so each link stays
honest.

## Decisions locked

1. **Direction: the maintained fact layer (not a viewing surface).** A
   standalone `dome claims` browser is the *least* valuable move — a window
   onto a layer that is mostly empty and otherwise already in the page. The
   value is in closing the loop.
2. **The garden fully authors and maintains claims** — mint new claim lines,
   supersede in place, refresh `*(as of)*` — as needed, not over-restricted.
   Land-then-review, consistent with the sweeper's existing trust policy
   (decision-ledger *Sweeper supersessions auto-land, 2026-06-09*); the brief
   digest + warden are the backstops. Invariant-clean: the agent writes
   markdown, the deterministic indexer extracts facts
   ([[wiki/invariants/MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS]] intact).
3. **The gist is a deterministically-rendered header block**, not a
   model-curated one. The garden authors claim *lines*; a generated
   `## Current facts` block is compiled from those lines (splice-guarded, no
   model — the `index.md` / `active-projects` generated-block pattern), so it
   honors [[wiki/invariants/NO_ACCRETING_REGISTRIES]] and the model never
   maintains a block.

## The loop, closed — four components across four bundles

| Link | Component | Bundle | Phase | Change |
|---|---|---|---|---|
| 1 Author | `sweep` + `consolidate` charters | dome.agent | garden | Mint *and* update claim lines (today: update-only) |
| 1.5 Render | `render-facts` (new) | dome.claims | garden | `## Current facts` block compiled from the page's claim lines |
| 2 Retrieve | `claimsFromFacts` decoder + sections | dome.search | view | Decode/label/group; first-class section in export-context/query/brief + ranking channel |
| 3 Health | `stale-claims` probe + `dome explain` | dome.claims / CLI | garden/view | As-of staleness surfacing; claim timeline from block git history |

### Link 1 — Authoring

Extend the sweep charter (and add the same guidance to `consolidate`, which
tidies the broader wiki) to **mint** claims, not only update them:

- **Claim-worthiness heuristic (guidance, not a gate):** promote a fact to a
  claim when it is (1) an attribute one would *look up* about the page's
  subject — status, owner, stage, dates, metrics, decisions, key
  relationships; (2) *likely to change* over time (so supersession earns its
  keep); or (3) load-bearing for downstream reasoning. Narrative, nuance, and
  one-off observations stay prose. Prefer few high-signal claims.
- **Supersession discipline preserved:** one claim per key per page, updated
  *in place* under its anchor (refresh `*(as of)*`, add the source wikilink).
  New *narrative* still goes in dated sections; the *claim* moves in place.
  This is what keeps the warden's same-key-collision check meaningful instead
  of firing on every dated section.
- **Compliance:** agent writes markdown → `dome.claims.stamp` anchors →
  `dome.claims.index` extracts facts. No new effect kind; land-then-review.

### Link 1.5 — The rendered fact-header

A new deterministic garden processor (`dome.claims.render-facts`) compiles a
splice-guarded `## Current facts` block (placed after frontmatter/title) from
the page's own claim lines:

- **Presentational format, not claim grammar.** The block renders as a compact
  table / plain dashes (`Key — value (as of date)` + anchor link), *not*
  `**Key:**` lines, so `dome.claims.index` never re-ingests the digest as new
  claims. Defense-in-depth: `claimsFromMarkdown` also excludes generated-block
  ranges.
- **Self-contained + idempotent.** Reads page content from the adopted
  snapshot and re-parses claim lines via the shared `claimsFromMarkdown` (garden
  processors cannot read the projection — the same constraint
  `dome.agent.active-projects` lives under). Splice-guard + fixed-point ⇒
  converges, no infinite re-trigger.
- **Threshold (config).** Renders only on pages with **≥ 3 claims** (default)
  so short pages stay clean.

### Link 2 — Retrieval (cheapest; the plumbing B and C need)

A shared `claimsFromFacts` decoder parses the JSON object once into
`{key, value, asOf, path, anchor}` and feeds:

- A first-class **"Current facts"** section in `export-context` (overview +
  per-entry), in `query` results, and woven into the **brief** — dated,
  labeled, with source anchors — replacing today's raw-JSON-in-the-generic
  bucket.
- A **claims ranking channel** in `dome.search` ranking: a query term matching
  a claim key/value is a strong signal, and the claim line becomes the answer
  snippet.
- **Data model:** keep the JSON-blob fact object for v1 (decode in the shared
  helper). A structured/queryable key column is **deferred** unless cross-vault
  key lookups prove heavy.

### Link 3 — Health (the VISION payoff)

- **Staleness probe (deterministic):** claims whose `*(as of)*` is older than a
  horizon (config, default ~120d) surface as a count in the brief and a
  `dome lint`-class finding ("7 claims unreviewed >120d"), with a gentle
  question only for the highest-signal ones. The per-fact version of the
  2026-06-09 doc's deferred "long-tail staleness refresh."
- **Contradiction:** keep the shipped same-page collision (warden);
  cross-page contradiction stays model-territory and is **deferred**.
- **`dome explain <page>#^anchor`:** the designed-but-unbuilt claim timeline,
  rendered read-only from the block's git history — "what did I believe in
  March."

## Invariant & safety posture

- **No new primitive / sealed core.** "Claim" remains a markdown convention
  plus deterministic processors; authoring is ordinary garden PatchEffects.
- **[[wiki/invariants/MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS]]** — the agents
  write markdown; facts are extracted deterministically. Untouched.
- **[[wiki/invariants/NO_ACCRETING_REGISTRIES]]** — the fact-header is a
  deterministic render, never a hand-appended file.
- **Safety boundary stays the write vocabulary.** Minting claims is within the
  sweep/consolidate charters' existing `patch.auto` glob; the broker enforces
  it; prompt-injection blast radius is unchanged (bad text on one page, a
  reviewable diff). Land-then-review + brief digest + warden audit.

## Build order (phased plan, one design)

- **Phase A — retrieval.** `claimsFromFacts` decoder + "Current facts" sections
  in export-context/query/brief + ranking channel. Cheap, immediate, and the
  plumbing B/C need.
- **Phase B — authoring + render.** Sweep/consolidate charter extensions +
  claim-worthiness heuristic + `dome.claims.render-facts`. The unlock; where
  the design care goes (charter wording, red-team for injected claim text,
  golden tests on the render).
- **Phase C — health.** `stale-claims` probe + `dome explain`.

## Acceptance (dogfood)

- A growing entity/project page accrues high-signal claim lines from the
  nightly garden (not just prose), and its `## Current facts` block reflects
  the current dated values.
- `dome query <subject>` and `export-context <topic>` return the subject's
  current claims as a labeled, dated, source-anchored section — not raw JSON.
- The brief surfaces a stale-claims count; `dome explain <page>#^anchor`
  renders a claim's value timeline from block git history.
- The render block is a deterministic no-op on re-run; claim minting lands
  overnight and shows in the brief's integrated digest.

## Deferred

- Structured/queryable claim key column (only if cross-vault key lookups get
  heavy).
- Cross-page contradiction detection (model territory).
- `consolidate` promoting *existing scattered prose* into claims (Phase B
  starts with sweep minting from incoming material; prose-promotion is a
  follow-on).
- Salience-triggered re-render / staleness-triggered refresh runs.
