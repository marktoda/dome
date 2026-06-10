---
type: brainstorm
tags:
  - design
  - claims
  - sweeper
  - consolidation
  - derived-layer
  - post-wedge
created: 2026-06-09
updated: 2026-06-09
status: approved-design
sources:
  - "[[wedge]]"
  - "[[v1]]"
  - "[[cohesive/brainstorms/2026-06-03-dome-task-lifecycle-and-llm-wardens]]"
  - "[[wiki/concepts/llm-wiki-pattern]]"
  - "[[wiki/syntheses/dome-as-compiler]]"
---

# Meaning consolidation — the claims substrate and the nightly sweeper

> **As-built note (2026-06-09):** the shipped claims substrate deviates from
> this doc in three details — anchors are `^c<hash>` (no hyphen), the grammar
> applies to `wiki/**/*.md` + `notes/*.md` (not "any page outside `raw/`"),
> and the stamper runs in **garden** phase per the `dome.daily.stamp-block-id`
> precedent. [[wiki/specs/claims]] is the normative spec.

Approved design from the 2026-06-09 brainstorm session. This is the first
post-wedge work item: aim the nightly loop at *meaning*, not hygiene. It
follows the 2026-06-09 research pass (capability inventory, prior-research
audit, product landscape, agent-memory literature) whose one-sentence verdict
was: retrieval and capture are near-solved; qualitative power comes from a
governed, continuously-consolidated **derived layer** — current
entity/project/commitment pages with per-claim provenance — and Dome's engine
is the right machinery currently pointed at the wrong altitude.

## Problem

The dossier layer already exists in the work vault (~222 entity pages;
`wiki/entities/alice-henshaw.md` is the reference example) and is already
agent-maintained — but only by the **foreground** agent, opportunistically,
during sessions that happen to touch a page. Nothing guarantees that material
which enters the vault (dailies, ingested captures, meeting notes, source
scans) is integrated into the pages it concerns. `dome.agent.consolidate` is a
janitor (merge duplicates, tidy drift), not a biographer. And claims on pages
carry only section-level provenance — no stable identity, no supersession
bookkeeping, no temporal queries.

## Decisions locked in the brainstorm

1. **Role: sweeper, not author-of-record.** The foreground agent stays the
   primary dossier author (it has full conversational context). The nightly
   pass is a completeness guarantee: anything that entered the vault gets
   integrated into the relevant pages even if no session touched them. "No
   capture left behind."
2. **Format: hybrid.** Narrative prose sections stay exactly as they are.
   Load-bearing facts become **claim lines** — the existing `**Key:** value`
   convention, anchored and indexed (grammar below).
3. **Claims are general, not entity-specific.** A claim is a vault-wide
   markdown primitive recognized by shape (like wikilinks and task blocks),
   valid on any page type. Only the sweeper's *targeting* policy mentions page
   types, and that is config.
4. **Trust policy: everything lands, review after.** Sweeper output — including
   in-place claim-line supersessions — lands overnight; the morning brief
   carries a digest; git diff + run ledger are the audit trail. This
   deliberately revises the 2026-06-03 memo's propose-first stance, scoped to
   the sweeper's restricted write vocabulary (see Safety).
5. **Architecture: deterministic spine + per-dossier LLM passes** (Approach B).
   Determinism decides *what must be integrated*; the model decides only *how
   to phrase the integration on one page*. Per-item patches; the night is not
   atomic.

## The claim grammar (vault-wide primitive)

A claim line is, on any adopted page outside `raw/`:

```markdown
- **<Key>:** <value prose, wikilinks welcome> *(as of YYYY-MM-DD)* ([[source-link]]) ^c-<slug>
```

- Optional list bullet; the `**Key:**` bold prefix is the recognizer, and it
  must open the line (after the bullet, if any). Lines inside code fences and
  blockquotes are never claims, so quoted material can't be over-anchored.
- `*(as of date)*` optional; fallback is the enclosing dated section or git
  date.
- Source wikilinks on the line are the claim's provenance refs; page-level
  `sources:` frontmatter remains coarse provenance.
- `^c-<slug>` is the stable identity, stamped deterministically when absent.
  Per the 2026-06-03 memo: explicit block-id, never body-hash.
- **Subject = host page** in v1. A claim about another page expresses the
  relation via wikilinks in the value (`**Lead:** [[wiki/entities/diana-kocsis]]`),
  traversable through the existing graph projection. Explicit other-subject
  claims are deferred.
- **Supersession = in-place edit under the same anchor.** Git history of the
  block through adopted commits is the bi-temporal store; no archive sections,
  no deletion. "What did I believe in March" is a derived view, not stored
  state.

Humans and the foreground agent keep writing plain `**Key:** value` lines;
anchoring is invisible maintenance.

## Components

New first-party bundle **`dome.claims`** (deterministic substrate):

| Processor | Phase | Capabilities | Does |
|---|---|---|---|
| `dome.claims.stamp` | adoption | `patch.auto` (wiki globs) | Anchor claim-shaped lines missing `^c-` ids. Idempotent; must be proven convergent in the fixed-point loop (the adoption-phase-writer question the 2026-06-03 memo flagged). |
| `dome.claims.index` | adoption | `graph.write` (`dome.claims.*`) | Parse claim lines → facts: (subject page, key, value, as-of, sourceRefs, blockId). Deterministic, rebuildable. |

Extended bundle **`dome.agent`** (nightly, garden phase):

| Processor | Kind | Does |
|---|---|---|
| `dome.agent.sweep-queue` | deterministic | Drift since the last sweep cursor → changed material (dailies, ingest archive, `notes/`, `wiki/sources/`) → candidate destination pages per material (wikilink targets + deterministic title/alias FTS hits within the targeting glob) → drop pairs already settled in the sweep ledger → ranked queue (recency × mention count), capped. |
| `dome.agent.sweep` | llm | Per queue item (one destination page + the material excerpts): append a dated narrative section in house style, update superseded claim lines in place, extend frontmatter `sources:`, add wikilinks — or raise a question, or record a no-op. Each item lands as its own patch. |

Schedule: ingest (event-driven all day) → 02:00 consolidate (janitor) → 03:00
sweep (meaning, integrates into post-merge pages) → 05:30 brief, which gains
an **"Integrated overnight"** block (dossiers touched, one line each, plus open
sweep questions).

**Targeting policy (config, not mechanism):** default destination glob
`wiki/entities/**` + `wiki/concepts/**`; widening to syntheses/projects is a
config edit. Dailies are never destinations (append-only journals) while being
the primary *source* material.

**Sweep ledger:** durable operational state alongside `answers.db`/`runs.db`
(gitignored, preserved, explicitly outside the projection-rebuild guarantee).
Rows: (material path, material content-hash, destination page, disposition,
run id). Settlement is per (content-hash, destination) pair; "nothing
meaningful" is a recorded no-op disposition so boring material isn't re-judged
nightly. The cursor advances past material only when all its pairs are
settled or questioned — a crashed run loses nothing.

## Invariant compliance

- `MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS` — untouched. The sweeper writes only
  markdown; durable claim facts are extracted by the deterministic indexer
  from adopted pages. Projections stay rebuildable.
- The four-concept core stays sealed: "claim" is a markdown convention plus two
  deterministic processors, never an engine primitive or new effect kind.
- `PROPOSALS_ARE_THE_ONLY_WRITE_PATH` / `ENGINE_IS_THE_ONLY_APPLIER` — sweep
  patches route as ordinary garden PatchEffects → sub-proposals → adoption.
- Past dailies append-only — sweep never targets them.
- No new named invariant required; AC3 lockstep untouched.

## Safety

- **The write vocabulary is the safety boundary.** The sweep agent's only
  mutating tool edits the single queue item's page; the charter forbids
  deleting or rewriting narrative prose (append sections, edit claim lines,
  extend `sources:`, add wikilinks — nothing else). The capability grant
  mirrors the charter: `patch.auto` on the targeting glob only; the broker
  enforces what the charter promises.
- **Prompt injection is the top modeled threat** (OWASP agentic #1; sweep reads
  exactly the untrusted surface). Mitigations: charter frames all material as
  quoted data, never instructions; no external-action or cross-page tools, so
  the worst injection outcome is bad text on one page, landing as a reviewable
  diff; a red-team scenario test ships with the processor.
- **Caps:** 20 destination pages/night and 5 new stub pages/night (config
  defaults), one file per item, model budget via existing `maxDailyCostUsd`.
  Overflow re-queues — the unsettled pair reappears tomorrow.
- **Decision-ledger entry:** *Sweeper supersessions auto-land (2026-06-09)* —
  scoped revision of the 2026-06-03 propose-first stance: add-only writes plus
  in-place claim-line edits land; wardens (when built) audit after the fact
  rather than gate before; the brief digest is the review surface.

## Error handling

- Per-item failure → `dome.agent.sweep-item-failed` diagnostic, pair stays
  unsettled, retried next night; after 3 consecutive failures it escalates to
  a question instead of retrying forever.
- Ambiguous identity (two plausible destination pages) or an unresolvable
  contradiction → existing question machinery; the answer-triggered processor
  applies the integration on resolve.
- No model provider → standard post-wedge behavior (doctor probe; loud, not
  silent).

## Testing

Spec edit first, then implementation, then tests (repo discipline):

- `dome.claims.stamp`: idempotency + fixed-point convergence in the adoption
  loop (per [[wiki/gotchas/processor-fixed-point-divergence]]).
- `dome.claims.index`: parsing goldens against real page excerpts (the Alice
  Profile block as a fixture); rebuild determinism.
- `dome.agent.sweep-queue`: queue determinism; settlement no-op on rerun;
  cursor semantics across crashes.
- `dome.agent.sweep`: hermetic scripted-provider tests (existing harness
  pattern); per-item atomicity (one failing item, the rest land); the
  injection red-team scenario (embedded instructions in material must produce
  no out-of-scope effects).

## Build order

1. **Claim substrate** — grammar spec page, `dome.claims.stamp`,
   `dome.claims.index`, tests. (Also the keystone the 2026-06-03 memo
   sequenced first; unblocks wardens and task lifecycle later.)
2. **Queue builder + sweep ledger** — deterministic spine, settlement.
3. **Sweep agent** — charter, tools, hermetic + red-team tests.
4. **Brief integration** — "Integrated overnight" block + question wiring.
5. **`dome explain <page>#^c-<slug>`** — per-claim timeline view derived from
   git history of the block (stretch).

Backfill over historical vault material is a manual `dome run` invocation
later, not part of v1 of this design.

## Deferred

- Explicit other-subject claims (asserting about Alice from inside a daily).
- Salience-triggered (non-cron) sweep runs after big days.
- Long-tail staleness refresh (revisit dossiers untouched for N months).
- Warden integrity pass over swept claims (next design after the substrate
  exists; the contradiction pre-filter gets the claims index for free).

## Acceptance (dogfood)

- For five consecutive dogfood days: every daily/capture/source file adopted
  during the day appears in the sweep ledger as settled or questioned by 07:00,
  and the brief's "Integrated overnight" block reflects it.
- A claim superseded by the sweeper shows the correct current value on the
  page, the prior value recoverable via the block's git history.
- Re-running the sweep with no new material is a recorded no-op (settlement
  holds; no model calls beyond queue-empty detection).
- `dome query` for an entity returns its current claims with source refs.
