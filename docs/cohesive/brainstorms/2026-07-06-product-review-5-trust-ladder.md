---
type: brainstorm
tags:
  - product
  - review
  - roadmap
  - trust
  - autonomy
  - contract
created: 2026-07-06
updated: 2026-07-06
status: review-findings
sources:
  - "[[cohesive/brainstorms/2026-07-06-product-review-4-stock-gardening]]"
  - "[[cohesive/brainstorms/2026-07-01-product-review-daily-ritual]]"
  - "[[wiki/concepts/client-model]]"
  - "[[VISION]]"
  - "[[philosophy]]"
---

# Product review 2026-07-06, round 5 — the gardener needs a trust ladder, and the contract needs to be one thing

Fifth first-principles review, run the same day product-review-4 Tier 1
(proposal review loop, question lifecycle) and stock-gardening phase 1 (split
proposals, attic janitor) merged and deployed. Evidence base: fresh
three-track audit — full surface inventory, background-loop topology, and a
read-only content/ops audit of `~/vaults/work` (991 md files, live daemon).

## Headline

The "bunch of small things, not an end-to-end product" feeling was correctly
diagnosed in rounds 1–2 and its causes are **fixed**: outputs reach the
ritual, intake is scripted, the propose path is real. What the fresh evidence
shows is different: **the system is internally coherent; what it lacks is a
coherent story of trust and delivery.** Dome does its job — a genuinely
healthy vault being genuinely maintained (0.3% broken links, drained inbox,
0 open questions, substantive engine diffs at ~$4.65/day) — but it does it as
~1,400 invisible commits a month, a pull-only morning note, and a phone agent
that can look but not act.

## Evidence (condensed)

Working, verified: wiki core is high-quality cited synthesis; the daily
edition is load-bearing and correct (07-06 brief named the day's three real
threads); gardening diffs are substantive, not churn; link integrity 99.7%;
runs.db decay and attention-discount removal already in flight from prior
rounds (report-card rows showing it are trailing-window history).

Broken or missing, verified:

- **Claims truncation** — the current-facts digest on `danny.md` renders
  mid-sentence fragments ("…an obvious multi-hop test (") because the claim
  grammar is line-based and the source bullet hard-wraps; markdown lazy
  continuation lines are dropped from the value. Trust-eroding exactly where
  stakes are highest.
- **Assistant ≠ contract** — the co-located chat agent behind `POST /agent`
  (the whole PWA/voice conversation) speaks a private 5-tool dialect
  (search/read/brief + gated create/edit) while MCP exposes 13 typed
  operations. The phone agent cannot settle, resolve, apply, reject, or even
  capture.
- **Autonomy is hardcoded** — propose-only vs auto-apply is a compile-time
  fact per processor; no user-legible model of *why* Dome may do X
  unsupervised, and no way to change it short of hand-editing grants.
- **Stock tools are one day old** — exactly 1 pending proposal exists; the
  split/attic thesis is unproven, and ~26 notes/-vs-wiki collisions have no
  plan after the pending 20-file attic proposal.
- **Ops tail**: health-recovery emitters still burn thousands of runs/week
  (two near-zero-productive); `lint-supersession` (62) and
  `validate-wikilinks` (43) timeouts/7d are whole-vault scans hitting the cap
  on a 991-file vault — they get worse with growth.
- Smaller: assistant named nowhere user-facing; legacy `answer` vs `resolve`
  verb; frozen `dome.ask/v1` schema name; 8 stray 2025 personal dailies.

## Mental-model changes

### 1. Autonomy is earned, not hardcoded — the trust ladder

Every mutating garden behavior sits on a ladder: **observe → propose →
auto**. The broker already implements the downgrade edge
(auto-exceeding-grant → propose). What's missing is the *graduation loop*,
and the elegant move is that **the gardener proposes changes to its own
autonomy through the same review loop it uses for content**:

- **Promotion**: a weekly trust-review pass reads proposal accept/reject
  stats; a behavior with ≥ M decided proposals and accept-rate ≥ threshold at
  propose level emits a *proposal* whose diff is the config/grant edit that
  promotes it — evidence in the reason, owner reviews with `dome apply`.
- **Demotion/retirement**: the report-card's zero-productive finding gets its
  consequence the same way — a proposal to disable or demote the behavior.

One mechanism unifies the safety model, the accept-rate metric (round 4's
"public-release trust artifact"), the second-user on-ramp (fresh install
starts everything at propose; autonomy is earned over weeks), and
retire-or-keep. No new primitives: two emitters + a scoped
`patch.propose: [".dome/config.yaml"]` grant + a trust column on the report
card. Quarantine already handles the *reliability* half of this ladder;
trust is the missing symmetric half.

### 2. One contract, one tool catalog

[[wiki/concepts/client-model]] says the product is the contract — then ships
an assistant that doesn't speak it. Generate the assistant's tools from the
same `src/surface/` collector catalog MCP maps 1:1. Payoff: the voice agent
in your ear can act ("close the Guidestar task" → settle; "apply the danny
split" → apply). For the app extension this is worth more than any new
panel, and it deletes the tool-dialect drift class the view-model already
deleted for views.

### 3. Onboarding is a gardening campaign (deferred to its own cycle)

Round 4's `notes/` backfill and the public onboarding motion are the same
feature: a **corpus-adoption campaign** — point Dome at pre-existing
sediment, get a bounded, budgeted, propose-only proposal stack about *your
own notes*. Accept-rate on that stack seeds the trust ladder and is the
sales demo. Dogfood on `notes/` first. Needs its own design pass (campaign
lifecycle, budgets, batch review UX) — deliberately not in this cycle's
plan.

### 4. Delivery: the edition should arrive, not wait (deferred with §3)

Push notification of the edition / non-empty attention queue is the app's
critical path, ahead of any new surface. A brief you fetch is a feature; a
brief that arrives is a habit.

## Plan

**This cycle** (plan of record:
[[superpowers/plans/2026-07-06-product-review-5-tier1]]):

1. Claims grammar absorbs lazy-continuation lines (fixes the truncated
   digest; anchor stamps to the last continuation line).
2. Health-trio run-volume + lint-timeout tuning (measure post-07-05 first).
3. `dome explain <path#^anchor>` — the provenance debugger over claims +
   ledger + trailers; collector-first so CLI/MCP ship together.
4. The trust ladder (promotion + demotion proposals + report-card trust
   column).
5. Assistant tools from the contract catalog (capture/settle/resolve/
   proposals/apply/reject, capability-gated).
6. Naming/docs sweep: name the assistant, retire `answer` verb docs-first,
   AGENTS.md miss-log line, stray-dailies attic candidates.

**Next cycles**: corpus-adoption campaign (design brainstorm first); push
delivery; per-device tokens with remote MCP.

Deliberate non-goals: no new engine primitives or effect kinds; no
embeddings absent miss-log evidence; no collapsing the four owner verbs
(resolve/settle/apply/reject — the typing is what makes daily blocks
self-documenting); no new PWA panels before the assistant speaks the full
contract.

## Release gates, restated measurably

1. **Trust**: every auto-apply class graduated through propose at least
   once; trailing-30d proposal accept-rate ≥ ~70%.
2. **Habit**: seven consecutive mornings where the edition arrived (push),
   was complete (sources present or loudly absent), and required no
   terminal.
3. **Stranger**: one non-owner points Dome at an *existing* vault and gets a
   useful proposal stack + first brief within 24h, docs only.

## Through-line

Rounds 1–4 built the loop; round 5's finding is that the loop needs a
*reputation*. Stop adding hands: give the gardener earned autonomy, one
contract every client speaks, an onboarding motion that shows the gardening,
and a brief that arrives on its own — and the felt product stops being "many
small things" and becomes "a gardener I can watch earning my trust."
