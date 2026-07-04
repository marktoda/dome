---
type: spec
created: 2026-06-09
updated: 2026-07-02
sources:
  - "[[cohesive/brainstorms/2026-06-09-meaning-consolidation-claims-and-sweeper]]"
  - "[[cohesive/brainstorms/2026-07-02-pruning-pass-design]]"
description: Claim-line grammar (bold key, as-of date, ^c anchor) and the dome.claims stamp/index/render-facts/stale-claims processors; supersession is an in-place edit under one anchor
---

# Claims

This spec is normative for the claim-line grammar and the dome.claims bundle's four processors.

A **claim** is a vault-general markdown primitive — like wikilinks and task
blocks — recognized by shape on any page matched by the bundle's globs
(`wiki/**/*.md`, `notes/*.md`; `raw/**` is never touched):

```
- **<Key>:** <value prose, wikilinks welcome> *(as of YYYY-MM-DD)* ^c<hash>
```

- The line-opening `**Key:**` bold prefix is the recognizer (after an optional
  list bullet). Lines inside YAML frontmatter, fenced code blocks, and
  blockquotes are never claims, so quoted material can't be over-anchored.
- The `*(as of date)*` marker is optional; omitted dates carry no assertion;
  consumers may fall back to coarser context (enclosing dated section, git date)
  as a convention — no standard read-time algorithm is defined yet.
- The `^c…` anchor is the claim's stable identity, stamped by
  `dome.claims.stamp` (garden, deterministic, idempotent). Identity hashes the
  normalized path + **normalized key** + occurrence index — never the value —
  and stamping never re-issues an anchor id already present in the document.
- **Supersession is an in-place value edit under the same anchor.** Git
  history of the block through adopted commits is the bi-temporal store: no
  archive sections, no deletion, "what did I believe in March" is a derived
  view.
- The claim's subject is its **host page**. Relations to other pages ride
  wikilinks in the value, traversable via `dome.graph.links`.
- **Enablement is lazy.** `changedPaths` is diff-scoped, so enabling the
  bundle stamps nothing by itself; pages acquire anchors on their next edit
  (or on initial whole-vault adoption). To stamp the *backlog* of pages that
  predate enablement in one pass, see §"Backfilling coverage on an existing
  vault" below.

## Processors

| Processor | Phase | Kind | Effect |
|---|---|---|---|
| `dome.claims.stamp` | garden | deterministic, `patch.auto` | Anchors claim lines lacking `^c…` ids; converges at depth 1. |
| `dome.claims.index` | adoption | deterministic, `graph.write dome.claims.*` | One `dome.claims.claim` fact per claim line: object = JSON `{key, value, asOf?}`, sourceRef carries the line range and, when the line is anchored, the stableId. Facts replace per path on edit and clear on delete (the manifest's `file.deleted` triggers are load-bearing). |
| `dome.claims.render-facts` | garden | deterministic, `patch.auto` | Compiles the `## Current facts` digest block (a `dome.claims:current-facts` generated block, presentational — not claim grammar) at the head of `wiki/entities/**` pages with ≥ `current_facts_min_claims` (default 3) non-placeholder claim lines, capped at 12 bullets; splices it out on any page below threshold or outside entity scope; idempotent. See §"`render-facts` charter" below. |
| `dome.claims.stale-claims` | view | deterministic, read-only | Lists claims whose `*(as of)*` is older than `stale_claims_horizon_days` (default 120), computed at command time from the injected clock (`ctx.now()`) — a `ViewEffect`, never a persisted fact; invoked via `dome stale-claims`. |

The three state-maintaining processors are registered as the
`dome.claim.coherence` maintenance loop; `stale-claims` is a read-only view,
invoked on demand.

The digest is a **deterministic render from the page's own claim lines** — the
same generated-block pattern as `index.md`/`active-projects`, holding to
[[wiki/invariants/NO_ACCRETING_REGISTRIES]]: the block is replaced wholesale
each pass, never accreted. It renders a presentational `- **Key** — value`
shape (bold key **without** the colon) so it is never re-parsed as a claim and
fed back into the index; for the same reason `claimsFromMarkdown` excludes the
`dome.claims:current-facts` block region.

### `render-facts` charter

Rechartered 2026-07-02 (pruning-pass design §3) after a live-vault audit found
two failures on the busiest entity page: a 75-line digest that restated the
page body word-for-word, and template placeholders
(`[Specific incident — fill in or drop]`) promoted into rendered "facts."
`render-facts` was also the single largest engine-commit churn category
(211 commits/14d). The charter now reads:

- **Scope: `wiki/entities/**` only.** A page outside that prefix is NEVER
  desired, regardless of its claim count. `dome.claims.stamp` and
  `dome.claims.index` are untouched — they still cover `wiki/**/*.md` and
  `notes/*.md` — only the digest's render scope narrowed.
- **Removal: the existing splice-out branch, unconditional outside scope.**
  A non-entity page carrying a stale `dome.claims:current-facts` block gets it
  spliced out (the same removal codepath that already fires below the claim
  threshold) the next time that page is touched — there is no whole-vault
  sweep; a page that is never edited again keeps its stale block until it is.
- **Cap: 12 bullets, most-recent-`asOf`-first.** Claims sort by `asOf`
  descending before capping; claims with no `asOf` sort last, ties keep
  document order. When the page carries more than 12 renderable claims, a
  `- +N more — \`dome query <subject>\`` tail line closes the list (the
  same cap idiom as `dome.daily`'s "To decide" block; `<subject>` is the
  page's own name, since the claim's subject IS its host page).
- **Placeholder filter: `[`…`]`-bracketed values never render.** A claim
  whose value — after stripping inline as-of markers and peeling trailing
  `[[wikilink]]` annotations (the sweep appends a source link when it
  supersedes a value; the annotation must not shield scaffolding from
  detection) — is exactly ONE `[`…`]` pair wrapping the entire remainder,
  with no interior brackets, is template scaffolding like
  `[Specific incident — fill in or drop]` and is dropped before the
  threshold count and before rendering. The test is deliberately
  conservative (the same posture as the grammar's discourse denylist —
  render a borderline real claim rather than drop a real fact): bracketed
  fragments inside a larger value (`[A] and [B]`,
  `Shipped v2 [beta] on 2026-06-01`, `[Owner] and [[Mark]]`) are real
  content and render; a whole-value `[[wikilink]]` is likewise never a
  placeholder.

**Backlog — cross-page subject attribution is inexpressible today.** The
originally-approved "external-only" charter (only surface what OTHER pages
say about this page's subject) could not ship: a `ClaimFact` carries no
source-page provenance field, so "what other pages say about the subject" is
not a filter claim structure can express — the claim's subject IS its
containing page, full stop. What shipped instead (scope + cap + placeholder
filter) attacks the audit's actual complaints — the 75-line self-restatement
and the laundered placeholders — without pretending to a provenance the claim
model does not carry. Adding cross-page subject attribution (a claim
recording which page(s) reference or discuss its subject, distinct from the
claim's own host page) is deferred claims-layer work; see also
§"Deferred" below.

## Backfilling coverage on an existing vault

The stamp fires only on **changed paths** (its triggers are `document.changed`
/ `file.created` signals, and those signals are derived from the adopted→HEAD
git tree diff). There is no whole-vault re-stamp verb: `dome run` dispatches
read-only *view-phase* processors (it rejects the stamp's PatchEffect as a
phase mismatch), and `dome rebuild` replays whole-vault signals but drops
PatchEffects, so neither stamps the backlog. A page that predates enablement —
or any claim line written before the bundle was on — stays unanchored until
that page next appears in a commit's diff.

The one-time **coverage step** is therefore an ordinary content commit that
puts every in-scope page into a diff, letting the garden stamp anchor the
backlog on the next tick (or `dome sync`). The transformation is idempotent
and converges at depth 1, so re-running it is safe and a fully-covered vault
is a no-op. Because there is no byte-identical diff, this is a real (if
trivial) edit — review the resulting patch, which should be anchor-only:

```bash
# From the vault root, with the daemon running (or run `dome sync` after).
# Append a single trailing newline to in-scope pages that lack one — a
# minimal, idempotent, reviewable touch that forces a diff; the stamp then
# anchors every unanchored claim line in the same garden pass.
find wiki notes -name '*.md' -type f -exec sh -c \
  'for f do [ -n "$(tail -c1 "$f")" ] && printf "\n" >> "$f"; done' _ {} +
git add -A wiki notes
git commit -m "chore(claims): backfill anchor coverage on existing pages"
```

Pages with no claim lines commit a harmless trailing-newline normalization and
acquire no anchors; pages with unanchored claims get their `^c…` ids stamped
by the daemon's next adoption tick. (Operators who prefer to avoid the
newline touch can instead let coverage accrue naturally — every page is
stamped the next time it is edited for any reason.)

## Invariant posture

The engine never learns about claims: a markdown convention plus four
deterministic processors. Model processors still emit no durable facts
([[wiki/invariants/MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS]]) — any LLM that
writes claim lines does so as ordinary proposed markdown, and this indexer
extracts the facts from adopted pages, preserving
[[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]].

## Consumers

The nightly sweeper (`dome.agent.sweep`, shipped — see [[wiki/specs/sweep]])
supersedes claim values in place; `dome explain <page>#^c…` (planned) renders
a claim's timeline from block git history.

**Same-page key-collision (self-consumer).** The `dome.claims.index`
processor is its own first consumer: because it already parses every claim
line, a same-page, same-normalized-key/different-value contradiction is caught
deterministically in the same pass and surfaced as a `warning`-severity
`DiagnosticEffect` with code `dome.claims.key-collision`, identified by a
per-key `stableId` so each colliding key self-clears via
`resolveStaleDiagnostics` when the page is reconciled. No projection read, no
model — the honest mechanical subset the claim lines make free. (This replaces
the retired `dome.warden.integrity` pre-filter, whose garden-phase
`ctx.projection.facts` read was dead code — garden phase omits the projection.)

**Model-judgment integrity review** — the fuzzier classes (historical-as-ongoing,
cross-page contradiction, self-corroboration, inference-as-fact) — rides the
nightly `dome.agent.consolidate` agent's `flagIntegrity` tool (see
[[wiki/specs/task-lifecycle]] §"Wardens" and [[wiki/specs/autonomous-agents]]
§"`dome.agent.consolidate`"), which emits `DiagnosticEffect`s only, never a
fact, keeping [[wiki/invariants/MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS]] intact.

### Health

Claim health splits into a **durable** signal and a **view-time** signal.
`dome.claims.stale-claims` (`view`, invoked via `dome stale-claims`) reads
the durable `asOf` already on every claim fact — emitted clock-free by the
adoption-phase indexer — and joins it against the current date at command time.
Staleness can therefore never be a persisted fact: a rebuild at a later date
would mint different rows from identical adopted markdown, so persisting it
would break [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]]. It is a
view-time signal by construction, the same rebuild-safe pattern as
`dome.search`'s recency decay.

Same-page contradiction (a same-normalized-key/different-value collision) ships
today via `dome.claims.index`'s key-collision diagnostic (above). The
remaining health items are still **deferred**: cross-page contradiction
(model judgment, not the indexer's mechanical subset); `dome explain
<page>#^c…`, the claim-value timeline rendered from block git history; and
brief-count weaving — surfacing the stale count in the morning brief.

## Deferred

A whole-file opt-out (frontmatter `claims: false`) and/or a templates-folder
exclusion, motivated by `{{placeholder}}` template files in real vaults —
required before enabling the bundle on a vault whose `notes/` carries
Templater templates.

**Cross-page subject attribution** — a `ClaimFact` carries no source-page
provenance today, so "what other pages say about this subject" cannot be
expressed as a filter over claim structure; see §"`render-facts` charter"
above for the full rationale. Would need a provenance field on `ClaimFact`
(or a separate cross-reference fact) before an "external-only" digest charter
becomes expressible.
