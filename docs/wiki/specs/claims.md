---
type: spec
created: 2026-06-09
updated: 2026-06-09
sources:
  - "[[cohesive/brainstorms/2026-06-09-meaning-consolidation-claims-and-sweeper]]"
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
  (or on initial whole-vault adoption).

## Processors

| Processor | Phase | Kind | Effect |
|---|---|---|---|
| `dome.claims.stamp` | garden | deterministic, `patch.auto` | Anchors claim lines lacking `^c…` ids; converges at depth 1. |
| `dome.claims.index` | adoption | deterministic, `graph.write dome.claims.*` | One `dome.claims.claim` fact per claim line: object = JSON `{key, value, asOf?}`, sourceRef carries the line range and, when the line is anchored, the stableId. Facts replace per path on edit and clear on delete (the manifest's `file.deleted` triggers are load-bearing). |

The pair is registered as the `dome.claim.coherence` maintenance loop.

## Invariant posture

The engine never learns about claims: a markdown convention plus two
deterministic processors. Model processors still emit no durable facts
([[wiki/invariants/MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS]]) — any LLM that
writes claim lines does so as ordinary proposed markdown, and this indexer
extracts the facts from adopted pages, preserving
[[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]].

## Anticipated consumers

The nightly sweeper (`dome.agent.sweep`, planned) supersedes claim values
in place; `dome explain <page>#^c…` (planned) renders a claim's timeline
from block git history; the warden contradiction pre-filter shortlists
same-key/different-value claims across pages.

## Deferred

A whole-file opt-out (frontmatter `claims: false`) and/or a templates-folder
exclusion, motivated by `{{placeholder}}` template files in real vaults —
required before enabling the bundle on a vault whose `notes/` carries
Templater templates.
