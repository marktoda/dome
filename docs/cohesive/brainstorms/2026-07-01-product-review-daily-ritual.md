---
type: brainstorm
tags:
  - product
  - review
  - roadmap
  - daily
  - questions
  - sources
created: 2026-07-01
updated: 2026-07-01
status: review-findings
sources:
  - "[[VISION]]"
  - "[[wedge]]"
  - "[[cohesive/brainstorms/2026-06-11-dome-v1-plan]]"
  - "[[wiki/concepts/client-model]]"
  - "[[cohesive/brainstorms/2026-06-26-questions-as-decisions-recategorize-integrity]]"
---

# Product review 2026-07-01 — the daily ritual is the product surface

First-principles product review before extending the PWA and opening Dome to a
second user. Three-track evidence base gathered 2026-07-01: full code/feature
inventory (all ten `dome.*` bundles, four surfaces), work-vault content audit,
and a 14-day live-engine operational audit of `~/vaults/work`.

## Headline

The gardening works and the brief is a real killer feature — but the product
loop is **open at both ends**. Intake is open (the owner is still the courier:
both source subscriptions are `enabled: false`; the daily's source line reads
`_Sources: calendar — · slack —_` every morning while the owner hand-pastes
digests). Settlement is open (a confirmed silent bug: the brief's "Open Dome
Questions" block has **never rendered once** — see §Confirmed bug). The middle
of the loop — adopt/tend machinery — is over-built relative to the ends, and
~77% of engine commits are mechanical churn. The felt symptom "Dome does many
small things but not an end-to-end product" has a precise cause: **features
thrive in exact proportion to how close their output lands to the owner's daily
ritual**, and half of them never reach it.

## Evidence base (condensed)

Working, verified:

- **Brief quality** — the 2026-07-01 edition correctly threaded the day's
  launch, a rolled-over coaching conversation, a re-rate clock, and an
  unaddressed burnout signal, all source-linked. This is the wedge promise,
  delivered.
- **Coherence** — 0 orphan pages of 390 entities/concepts; inbox fully
  drained; the consolidation ledger records real dedup *reasoning*; 37
  consecutive dailies; essentially the whole wiki human-touched in 30 days.
- **Reliability** — 0 failed runs, 0 orphan runs, clean outbox, ~$39/week
  model spend under caps.

Broken or leaking, verified:

- **Settlement** — 10 questions open (8 stale-task, 2 quarantine-recovery),
  none ever surfaced in a daily. `dome.daily.attention-discount` quarantined
  since 2026-06-18; the question asking to reset it never reached the owner.
- **Intake** — `sources/` holds two calendar files from June 10–11 and no
  `sources/slack/` at all. Overnight Slack digests in dailies come from the
  owner's own morning commits. Connector-fetch was corrected to
  foreground-only ([[cohesive/brainstorms/2026-06-11-dome-v1-plan]] WS5
  correction) but nothing replaced the daemon path.
- **Churn** — of 585 engine commits in 14 days, ~450 are mechanical: claims
  stamp + render-facts (210), `meta/sweep-ledger.md` rewritten 136×,
  one-line frontmatter touches (74). WS1 declared git the native activity
  log; the log is now ~77% stamp noise.
- **Meaning-level gardening gaps** — `wiki/entities/danny.md` at 1,058 lines
  is four documents in one; the `current-facts` digest restates the page's own
  body (Base timeline twice in one file) and leaks placeholder cruft;
  `notes/` and `raw/` are frozen since import, outside the coherence loop;
  the Danny promo synthesis trio remains unreconciled.

## Confirmed bug — the questions block never shipped

`src/processors/context.ts` §ProcessorContext documents that adoption- and
garden-phase invocations **omit `ctx.projection`**. `dome.agent.brief` is a
garden processor; its questions batch reads
`ctx.projection?.questions({ resolved: false })` — always `undefined`, always
optional-chains to `[]`, and `questionsBriefSection` returns `null` on empty,
omitting the block. Net: [[wedge]] Phase 4's "open Dome questions batch, one
tap each" has never rendered in any daily. The brief's stale-loops pre-run
context (`ctx.projection?.facts(...)` over `dome.attention.discount`) is dead
the same way.

**Meta-lesson (candidate invariant `NEEDS_ARE_LOUD`):** three independent
findings share one root pattern — *silent degradation on missing capability*:
the `?.` on absent projection here, the grant-starved `dome.claims.*`
processors silently skipping `notes/`, and the historical model-provider
silent no-op [[wedge]] §Diagnosis called out. A processor that declares a need
it doesn't receive must surface a diagnostic, the way doctor's grant-starvation
probes already do. Structural > check-script > prose ([[philosophy]]).

## Mental-model changes

1. **The daily note is the product's UI.** The four operators describe the
   engine; nothing names where value lands. Product-level rule: everything the
   engine wants *from* the owner (questions, escalations) or *for* the owner
   (briefs, digests, integrations) lands in the daily-ritual surface — the
   daily note on desktop, the same content behind the PWA Brief panel.
   Anything that cannot name its slot in the ritual is a retirement candidate.
   This generalizes the case-by-case rulings in
   [[cohesive/brainstorms/2026-06-26-questions-as-decisions-recategorize-integrity]]
   and [[cohesive/brainstorms/2026-06-27-sweep-escalations-as-diagnostics]].
2. **The foreground agent is the integration layer — by design, not regret.**
   The morning foreground session is a reliable, daily, already-happening
   execution context where connectors work. Productize it as a named `/morning`
   ritual contract in the vault AGENTS.md (agent fetches calendar + Slack →
   writes `sources/*/YYYY-MM-DD.md` → `dome sync` → reads back the enriched
   brief). Separately, calendar has a deterministic daemon path
   (icalBuddy/EventKit) that should ship so the meetings section works before
   any terminal opens.
3. **Questions need a time axis.** The lifecycle has an automation-policy axis
   but no decay. Eight "close, defer, or keep?" prompts are one weekly-review
   ritual misrendered as a pile. Unanswered N days → batch-escalate into a
   single ritual item, or expire when the subject settles itself.
4. **The deletion test ran itself.** `attention-discount` has been dead two
   weeks with zero user-visible loss — evidence the three-way stale-task
   machinery (attention-discount / stale-task-warden / carry-forward) should
   collapse. Likewise `dome.warden.integrity` (221 runs/week, $8.62, a handful
   of diagnostics) overlaps consolidate's charter.

## Plan

### Tier 1 — close the loop (before extending the app)

1. **Questions reach the ritual.** Fix the projection-less garden context so
   the open-questions batch actually renders — and consider moving the block
   out of the LLM brief processor entirely (it is already "deterministic,
   never model-written"; a deterministic owner of the questions block can
   update it whenever questions change, not only at 05:30). Ship the
   loud-on-missing-capability diagnostic with it.
2. **Deterministic calendar fetch + the `/morning` ritual contract.** Closes
   intake with zero new engine surface.
3. **Coalesce mechanical garden commits.** One hygiene commit per tick, not
   one per processor per file; restores git-as-activity-log and cuts adoption
   churn ~4×.

### Tier 2 — meaning-level gardening (the original promise)

4. Page right-sizing: gardener *proposes splits* for accreted pages
   (danny.md-class), propose-not-auto.
5. `current-facts` becomes aggregation of what the *rest* of the vault says
   about the subject — never a restatement of the page body; placeholder cruft
   dies with it, and most stamp/render churn too.
6. Explicit scope decision for `notes/` and `raw/` — garden them or mark them
   out-of-scope in config; no silent limbo.
7. Collapse the stale-task trio; fold warden's charter into consolidate or
   leave it opt-in without per-change triggering.

### Tier 3 — second-user readiness

8. `dome init` day-one value: first real brief within 24h of init + API key
   (agent bundle + provider wired, not scaffolded-but-disabled).
9. Grant presets (`grants: standard`) expanding to the fine-grained form; raw
   YAML stays as escape hatch; fix the `--refresh-config` merge hazard.
10. An apply surface for `patch.propose` (currently blockable with no
    first-class accept verb).
11. Instrument the wedge metric: **resurfaced-and-acted-on**, plus a weekly
    garden report card (what each processor changed, what it cost, what got
    acted on) — the retire-or-keep instrument and the answer to whether
    consolidate+sweep at ~$27/week earn their keep.

### PWA note

The PWA shape (brief + recents framing agent chat + voice capture) is right
per [[wiki/concepts/client-model]]. But its Brief panel reads the today view
(projection-backed), so the phone shows questions the desktop ritual never
sees — fix Tier 1.1 before drawing conclusions from phone usage. And a phone
brief without meetings/Slack is a worse copy of the hand-built one — Tier 1 is
the app's critical path, not a competitor to it.

## Through-line

Dome does not need more features. It needs its existing outputs routed to the
one surface the owner already lives in, and its inputs to stop depending on
the owner. The engine layer is finished enough to stop investing in
generality; every marginal hour goes furthest on brief-adjacent plumbing.
