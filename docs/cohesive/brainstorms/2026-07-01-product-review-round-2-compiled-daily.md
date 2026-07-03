---
type: brainstorm
tags:
  - product
  - review
  - roadmap
  - daily
  - questions
  - economics
created: 2026-07-01
updated: 2026-07-01
status: review-findings
sources:
  - "[[cohesive/brainstorms/2026-07-01-product-review-daily-ritual]]"
  - "[[wiki/concepts/client-model]]"
  - "[[wiki/concepts/surface-view-model]]"
  - "[[wiki/specs/daily-surface]]"
  - "[[philosophy]]"
---

# Product review 2026-07-01, round 2 — compile the daily, budget the attention

Second same-day pass over the
[[cohesive/brainstorms/2026-07-01-product-review-daily-ritual|round-1 review]]:
verified its claims against the live engine, corrected one, and pushed one
level deeper on the architecture underneath the "loop open at both ends"
diagnosis. Evidence base: fresh three-track audit (full code/behavior map,
work-vault content audit, 14-day live-ops audit of `~/vaults/work`).

## Verification of round 1

Confirmed: the brief's questions block has never rendered in any of 44 dailies
(garden ctx omits `ctx.projection`; `brief.ts` optional-chains to empty);
both source subscriptions `enabled: false`, `sources/` dead since 06-14 while
the daily prints the empty sources line every morning; `attention-discount`
quarantined since 06-18 with zero felt loss.

**Corrected:** churn is ~64–74% of engine commits, not 77% — and sweeps are
*substantive* (124/136 write real content). The firehose is **claims stamps +
render-facts: 211 commits/14d**, the single largest category.

## New evidence this round

- **Cost doubled WoW** ($21.64 → $44.01). Top spender after sweep/consolidate
  is `dome.warden.integrity` ($13.69/14d, 412 runs) — producing diagnostics
  **no surface renders**.
- **No-op cycles at scale:** the health trio ran ~60k times/14d on per-minute
  crons (outbox-recovery: zero effects all window); `sources.fetch` polls
  4×/hr with everything disabled; `ingest` productive in 2 of 359 hourly runs.
- **Dead/invisible machinery:** `JobEffect` has spec + routing + table and
  zero users; `prep`/`agenda-with`/`orphan-pages`/`stale-claims` views have no
  CLI verb (only `dome run`); `dome.graph` facts render nowhere.
- **`current-facts` is the weak machine layer on the best pages:** danny.md's
  75-line digest restates the body word-for-word, strips section context, and
  promoted template placeholders (`[Specific incident — fill in or drop]`)
  into "facts" — violating core.md's own "link the source, don't restate it."
- **Settlement partially healed:** 84 questions answered lifetime (the
  reclassification work drained the June firehose), but all 10 currently open
  are owner-needed and idle — they still never reach the ritual surface.
- **The vault itself is better than round 1 implied:** flagged-not-merged
  contradictions, confidence-graded claims, a consolidation ledger recording
  *why* pairs are NOT duplicates, >99.7% of 14,523 wikilinks resolving.
- **PWA:** correctly shaped per [[wiki/concepts/client-model]], shares the
  `today-view` view-model — but the task checkbox is decorative (no phone
  settle path).

## Mental-model changes (the round-2 contribution)

### 1. The brief is compiled, not generated — a masthead, not a 05:30 edition

Every observed brief bug is one symptom: staleness (the 06-30 hand-annotated
"mirrors yesterday's 1:1s"), the never-rendered questions block (deterministic
content trapped inside a garden-phase LLM processor that can't see the
projection), the dead sources line (a block owner that never checks its input
exists). The fix is structural, not per-bug: **each daily block gets a
deterministic owner that re-renders whenever its inputs change** — questions
when the questions table changes, meetings when a calendar file lands, sources
when sources land (or render nothing). The LLM writes only narrative blocks
and re-runs on material input change, not on a clock. This is
[[wiki/concepts/surface-view-model]] applied to the daily note: the daily is a
materialized view over the projection. The [[wiki/specs/daily-surface]] block
ownership table already exists; the change is who owns the deterministic
blocks and what triggers them.

### 2. Owner attention is a budgeted resource

Five output channels exist (daily blocks, questions, diagnostics, `dome
check`, view commands); only the daily reliably lands. The
questions-as-decisions taxonomy is right but lacks **routing** (every
owner-facing emission names its slot in the ritual surface or doesn't ship —
the generalization of the integrity and sweep-escalation rulings) and
**decay** (questions are the one accumulate-only state machine; unanswered N
days → weekly-review batch or expiry). The ritual surface carries a fixed
attention budget (≈3 decisions + 5 loops + 1 digest); everything bids, ranked
by impact × staleness.

### 3. `NEEDS_ARE_LOUD` as a run-time invariant

Four incidents, one root: a declared need goes unmet and the component
silently degrades (`?.projection`, grant-starved claims processors skipping
`notes/`, the historical provider no-op, `--refresh-config` never merging
grants). Promote doctor's check-script probes to structure: a processor whose
declared capability/context dependency is absent at run time emits a warning
diagnostic, pinned by an AC3-lockstep invariant test. This is also the
biggest second-user gate: the owner debugs silent no-ops; a stranger
concludes "Dome doesn't work."

## Pruning list (the deletion test already ran)

| Candidate | Evidence | Action |
|---|---|---|
| attention-discount + 4-proc stale chain | quarantined 13d, zero felt loss | collapse to warden + settle-answer |
| warden.integrity per-change | $13.69/14d, renders nowhere | weekly at most; output → ritual digest; or fold into consolidate |
| current-facts charter | restates body, launders placeholders, top churn | digest = what *other* pages claim about the subject; length cap; suppress on curated pages |
| health trio per-minute crons | ~60k runs/14d, queue changes weekly | signal-triggered, one processor |
| sources.fetch while disabled | 1,419 no-op runs/14d | don't schedule with no enabled subscription |
| JobEffect + scheduled_jobs | zero users | delete or `tier: deferred` |
| retired-legacy daily helpers, frozen log.md | spec calls helpers deletable | delete; disambiguate log.md |
| ingest/consolidate/sweep overlap | three LLM writers on `wiki/**` | crisp one-line charters + uniform ledgers |

Cuts ~40%+ of LLM spend, kills the largest commit-noise source, shrinks the
trust surface.

## Build list

1. **Compiled-blocks daily** (above) — the highest-leverage change.
2. **Deterministic calendar fetch** (EventKit/icalBuddy → sources file from
   the daemon); Slack stays foreground via a named **`/morning` ritual
   contract** in vault AGENTS.md.
3. **`task.settle` as a typed contract operation.** Settling is a *decision*,
   not authoring; `settle-stale-answer` already applies close/defer/keep as a
   deterministic patch through the adoption loop. Generalize to an HTTP/MCP
   verb shaped like `resolve` — no violation of
   [[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]]. Unlocks the PWA
   checkbox and the full phone glance-and-settle loop.
4. **Weekly garden report card**, promoted from round-1 Tier 3: per-processor
   what-changed / what-it-cost / what-got-acted-on. Simultaneously the
   retire-or-keep instrument, the wedge metric
   (resurfaced-and-acted-on) instrumented, and the public-product trust
   surface.
5. **Hygiene:** open-loop dedup (capture vs carry-forward twins), close-block
   redundancy, one-time `notes/` link normalization (~25 links, ~9 orphans) +
   explicit garden-or-out-of-scope call for `notes/` and `raw/`.

Deliberately not: new PWA panels before 1–3 land; new effect kinds; new
engine generality.

## Readiness gates

1. **Loop closes for the owner** — exit: seven consecutive mornings where the
   7am note is complete, nothing stale or empty, no terminal.
2. **System prunable and legible** — exit: report card shows every running
   processor produced owner-visible value that week; any grant/config error
   is loud within one tick.
3. **A stranger succeeds** — exit: `dome init` + API key → useful brief
   within 24h, no source-code reading (grant presets, refresh-config merge
   fix, task.settle + PWA polish).

## Through-line

The engine's middle is trustworthy — 0 failed runs, a provably coherent vault
after 37 autonomous days. The owner still operates three of the loop's four
segments (intake courier, settlement queue, staleness corrector). Close the
ends, prune what the deletion test condemned, and the "bunch of small things"
collapses into one legible product: a brain that briefs you every morning and
only asks questions worth answering.
