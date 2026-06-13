---
type: spec
created: 2026-06-09
updated: 2026-06-12
sources:
  - "[[cohesive/brainstorms/2026-06-09-meaning-consolidation-claims-and-sweeper]]"
description: Claim-line grammar (bold key, as-of date, ^c anchor) and the dome.claims stamp/index processors; supersession is an in-place edit under one anchor
---

# Claims

This spec is normative for the claim-line grammar and the dome.claims bundle's two processors.

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

The pair is registered as the `dome.claim.coherence` maintenance loop.

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

The engine never learns about claims: a markdown convention plus two
deterministic processors. Model processors still emit no durable facts
([[wiki/invariants/MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS]]) — any LLM that
writes claim lines does so as ordinary proposed markdown, and this indexer
extracts the facts from adopted pages, preserving
[[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]].

## Consumers

The nightly sweeper (`dome.agent.sweep`, shipped — see [[wiki/specs/sweep]])
supersedes claim values in place; `dome explain <page>#^c…` (planned) renders
a claim's timeline from block git history.

The **integrity warden** (`dome.warden.integrity`, shipped — see
[[wiki/specs/task-lifecycle]] §"Wardens") is the wired consumer of the
`dome.claims.claim` facts. It reads them through its garden-phase
`ctx.projection` view and runs a deterministic same-page,
same-normalized-key/different-value contradiction PRE-FILTER before trusting
the model: each mechanical collision becomes a high-risk contradiction
QuestionEffect directly (no model needed), and the collision also gates the
warden's noisier model findings (§"Wardens"). Cross-page contradiction
remains the model's judgment; same-page key collision is the deterministic
subset the facts make cheap. The warden still emits QuestionEffects only — it
never writes a fact — so this consumer keeps
[[wiki/invariants/MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS]] intact.

## Deferred

A whole-file opt-out (frontmatter `claims: false`) and/or a templates-folder
exclusion, motivated by `{{placeholder}}` template files in real vaults —
required before enabling the bundle on a vault whose `notes/` carries
Templater templates.
