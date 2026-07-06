---
type: brainstorm
tags:
  - product
  - review
  - roadmap
  - proposals
  - questions
  - gardening
created: 2026-07-06
updated: 2026-07-06
status: review-findings
sources:
  - "[[cohesive/brainstorms/2026-07-01-product-review-daily-ritual]]"
  - "[[cohesive/brainstorms/2026-07-01-product-review-round-2-compiled-daily]]"
  - "[[wiki/concepts/client-model]]"
  - "[[VISION]]"
  - "[[philosophy]]"
---

# Product review 2026-07-06, round 4 — flow gardener, stock gardener

Fourth first-principles review, run after product-review-3 shipped and deployed
(settle loop, report card, patrol, pruning, second-user kit — merge
`d9890072`, 2026-07-05). Evidence base: fresh four-track audit — engine
behavioral map, full bundle inventory, surface catalog, and a work-vault
content/usage audit of `~/vaults/work` (992 md files, 200-commit git window).

## Headline

Rounds 1–3 worked: the loop is closed at both ends and the **flow** path is a
real product. Captures become wiki pages, briefs are grounded and useful,
consolidation is discerning, 85% of commits are the engine's, and the owner's
own commits are all high-value knowledge work.

But the original promise is **stock** coherence — dedup, right-sized pages,
resolving links, reconciled disagreement across the whole corpus over years —
and that is exactly where the vault audit found rot: `danny.md` at 124 KB /
1,161 lines; the same task rendered twice in one daily under two anchors; ~40
dead diagram wikilinks; a zombie question about a retired processor
re-rendered every morning; `notes/` holding 19 empty files and `Untitled
1–15`; `preferences/signals.md` empty since creation. **Dome tends what flows
through it and barely touches what sits in it.**

## The structural cause: the propose path is a dead end

Verified on main: a garden `PatchEffect { mode: "propose" }` is **silently
dropped** with an info diagnostic — `src/engine/core/apply-effect.ts` says
"the garden propose review surface is not wired in v1.0." There is no proposal
store, no apply verb, no review surface on any adapter. Yet propose-not-auto
is the stated safety model for every meaning-level change. So every ambitious
gardening behavior is structurally capped at "emit a diagnostic and hope" —
patrol can *flag* `page.oversized` but nothing can ever *fix* danny.md.
"Propose" currently means three unrelated things: block-the-commit (adoption),
silently-discard (garden), and an ad-hoc `askOwner` question (consolidate's
charter). Round 1's Tier-3 item 10 named this; it never shipped. It is the
single highest-leverage piece of the system.

## Mental-model change: complete the owner-facing state machine

The engine-side four concepts are done and sealed. The owner-side vocabulary
is incomplete. Three owner-facing object kinds:

| Kind | Owner verb | Lifecycle | Status |
|---|---|---|---|
| Question | decide (`resolve` / `settle`) | should expire + escalate | shipped, but immortal |
| Diagnostic | FYI — fix the source | self-clears | shipped, works |
| **Proposal** | **review — accept/reject a diff** | pending → applied/rejected | **missing** |

Two rules:

1. **Proposals become real.** Garden propose patches land in a durable pending
   store, render as a "To review" block in the daily (and the PWA), and get
   one verb pair: `dome apply <id>` / `dome reject <id>` (CLI + HTTP + MCP,
   the settle pattern). Accepting is an ordinary human-side commit the daemon
   adopts — no new write path. **Accept-rate becomes the gardener trust
   metric**, which is also the public-release trust artifact.
2. **Attention items get a time axis and a liveness predicate.** Questions
   have no aging, no expiry, and can accumulate forever; the zombie warden
   question (subject retired 07-05, question immortal) is the proof case.
   Questions gain subject liveness (emitting or subject processor retired →
   expire with an audit row) and aging escalation (open ≥ N days → weekly
   review, not daily repetition).

## Findings inventory (condensed)

Working, verified: brief/agenda/close cycle; sweep→entity integration;
consolidate's duplicate discernment (correctly declines non-duplicates);
patrol rotation; active-set freshness (0 pre-June entity/concept pages);
99.6% wikilink integrity; settle loop end-to-end; report card rendering.

Broken or missing, verified:

- **Garden propose drop** (above) — blocks all stock-level gardening.
- **Question lifecycle** — no decay; zombie orphan-run question re-surfaces
  daily; stale-resolution silently deletes with no trace.
- **Semantic duplicate open loops** — 2026-07-05 daily renders "Send Danny the
  exact text passages…" and "Post the system-level ownership message…" twice
  each (synthesis-sourced wording vs carried dated wording; exact-key dedup
  can't fold different phrasings).
- **Claims grammar promotes narrative** — danny.md's digest renders "told
  Danny he needs to outwardly own his" (an unfinished human-authored line from
  a 07-02 debrief) because numbered bold headers (`**1. Tone feedback…:**`)
  parse as claim keys.
- **Stock rot with no owner**: oversized pages (18 entities > 20 KB), legacy
  `notes/` debris, `.trash/` (85 entries), dead diagram links, 680 KB log
  archive.
- **Intake owner-faithful, not self-healing**: `sources/slack/` has one file
  ever; calendar toggled on/off; the brief renders no loud absence line.
- **Preference promotion dormant**: zero signals ever recorded.
- Smaller: `grants: standard` all-or-nothing opt-out; assistant reachable only
  via HTTP `POST /agent` and named nowhere; unbudgeted spend when a provider
  omits `costUsd`; 05:00–06:00 cron chain is an implicit dependency graph.

## Plan

**Tier 1 — close the review loop, fix the visible rot** (plan of record:
[[superpowers/plans/2026-07-06-product-review-4-tier1]]):

1. Pending-proposal store + `queued-for-review` routing + `proposals.changed`
   signal + `dome proposals` / `dome apply` / `dome reject` (CLI/HTTP/MCP) +
   daily "To review" block + status/check integration.
2. Question lifecycle: subject-liveness expiry (kills the zombie class) +
   aging escalation into the weekly review block.
3. Bug fixes: near-duplicate open-loop folding (token-Jaccard, conservative);
   numbered-key exclusion in the claims grammar.

**Tier 2 — aim the gardener at the stock** (next review cycle): page
right-sizing via proposals (danny.md is the acceptance test); a
backfill/adopt-existing-corpus campaign (simultaneously the `notes/` janitor
and the missing public-onboarding motion); mechanical-debris janitor loop.

**Tier 3 — intake robustness + the meta-loop**: loud source absence in the
brief; push notification of the brief; report card → consequence (0-productive
3 weeks → self-raised retire-or-tune question).

Deliberate non-goals: no new effect kinds or engine primitives (the proposal
store is routing + surface); no daemon Slack fetch (consent posture stands);
no new observability commands.

## Through-line

The system can *observe* everything but may only *act* on the safe subset.
Wire the review loop, give attention items a lifecycle, then point the
existing agents at the stock — and the same codebase becomes the VISION doc's
gardener: one you can watch working, whose proposals you accept at a
measurable rate.
