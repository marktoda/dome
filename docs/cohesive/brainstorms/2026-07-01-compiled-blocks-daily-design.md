---
type: brainstorm
tags:
  - design
  - daily
  - questions
  - brief
  - engine
created: 2026-07-01
updated: 2026-07-01
status: design-approved
sources:
  - "[[cohesive/brainstorms/2026-07-01-product-review-round-2-compiled-daily]]"
  - "[[wiki/specs/daily-surface]]"
  - "[[wiki/specs/autonomous-agents]]"
  - "[[wiki/specs/task-lifecycle]]"
  - "[[philosophy]]"
---

# Compiled-blocks daily — design

Approved design, 2026-07-01. Inverts the daily-note pipeline from a 05:30 LLM
"edition" to per-block ownership where **deterministic blocks have a
deterministic owner that re-renders when inputs change** and the LLM writes
only narrative blocks, re-running exactly when its inputs materially change.
Fixes structurally: the never-rendered questions block, the pre-sync stale
brief, and the dead sources line
([[cohesive/brainstorms/2026-07-01-product-review-round-2-compiled-daily]]
§"compiled, not generated").

## Decisions taken

1. **Scope: full inversion** — all deterministic blocks move out of the
   brief; not a surgical questions-only fix.
2. **Trigger: store-change signal** — a new `questions.changed` signal kind,
   not hard-wired dispatch, not on-commit best-effort.
3. **Meetings: split** — deterministic agenda block + model prep prose.
4. **Shape: one compositor** (Approach A) — a single deterministic garden
   processor owns all deterministic blocks; per-block processors (B) rejected
   as machinery-per-outcome and anti-coalescing; an engine-level materialized
   -block primitive (C) rejected as generalize-at-N=1 ([[philosophy]]) — the
   compositor is the thing to promote if a second materialized surface
   appears (core.md's gated writers, a weekly report card).

## Section 1 — Engine surface (the only engine changes)

**1a. `questions.changed` signal.** Emitted when the question store mutates:
after any tick whose effect routing landed a `question.ask` (new or
refreshed-open), and after any resolve (CLI/HTTP/MCP/auto-resolution) marks a
question resolved. Coalesced to at most one signal per tick. Dispatched
through the existing signal path; manifests subscribe like a file signal —
the trigger vocabulary gains one kind and stays uniform.

**1b. `ctx.questions` narrow garden read view.** Read-only
(`ctx.questions.open()` → id, text, options, automationPolicy, risk,
recommendedAnswer, askedAt, sourceRefs) for garden processors declaring a new
`questions.read` capability, granted per-vault. Deliberately NOT full
`ctx.projection` in garden phase: facts stay out of garden reads (no
garden-writes-facts → garden-reads-facts loops). Loud by construction: a
processor that declares `questions.read` and does not receive the store gets
a **runtime-emitted warning diagnostic**, never a silent `undefined` — the
NEEDS_ARE_LOUD pattern applied locally (the general invariant is a separate
workstream).

## Section 2 — `dome.daily.compose-blocks` (the compositor)

One deterministic garden processor in `dome.daily`, owning four blocks in
**today's daily only**:

| Block | Content | Notes |
|---|---|---|
| `dome.daily:questions` | "To decide" — top **3** open questions (owner-needed first, then oldest): one-line text, recommended answer when present, literal `dome resolve <id> <value>` command; `+N more — dome check` tail when capped | Under `## Start Here`, after the yesterday block. Renders to *removed* when no open questions — resolving the last question cleans the page (desktop parity with the PWA optimistic drop) |
| `dome.daily:agenda` | Deterministic agenda (time · title · attendees) from `sources/calendar/<today>.md`, same defensive parser as the cockpit path | Top of `## Meetings`; omitted when no calendar file |
| `dome.daily:integrated` | Sweep-ledger digest — renderer moves verbatim from the brief | Replaces `dome.agent.brief:integrated` |
| `dome.daily:sources` | Honest sources record (✓/— per source), rendered **only for source kinds with an enabled subscription or a file present today** — a vault with no sources configured and none landed gets no line at all, never a perpetual `calendar — · slack —` | Replaces `dome.agent.brief:sources`; no longer the brief's re-compose gate (fingerprints replace that, §3) |

**Triggers:** `questions.changed` + file signals on `meta/sweep-ledger.md`
and `sources/{calendar,slack}/*.md` + cron **05:25** (after active-projects
05:20, before the brief 05:30; wake-tick collapse preserves the order). Each
fire re-renders all four blocks from current inputs, emits **one patch** →
one engine commit; byte-identical renders skip (most fires are free no-ops).
Creates the shared skeleton when today's daily is absent (one skeleton shape,
N writers, last-writer no-ops).

**Marker migration:** `brief:questions` never rendered — free rename.
`brief:integrated`/`brief:sources` exist in live dailies: compose-blocks
removes the old-namespace blocks from today's daily in the same patch that
writes the new ones (the `start-context` retirement precedent — one-time,
idempotent, historical dailies untouched, old markers stay recognized for
anomaly-scanning and non-reingestion).

## Section 3 — Slimmed brief + input-fingerprint gating

`dome.agent.brief` keeps exactly three model blocks: `brief:today`,
`brief:yesterday` (dual-writer contract untouched), `brief:meetings` (now
prep-context prose only — people, prior decisions, open threads — below the
deterministic agenda). Dead `ctx.projection?.` reads are **deleted, not
fixed** (questions left the brief's charter; the stale-loops facts read dies
with the attention-discount retirement track).

**Staleness fix:** each model block's opening marker gains an optional
`inputs=<short-hash>` attribute (one extension to the core generated-block
grammar in `src/core/generated-block.ts`, parsed centrally). Material inputs
per block: `meetings` → hash(today's calendar+slack blobs); `yesterday` →
hash(yesterday's daily); `today` → hash(calendar + slack + today's
sweep-ledger section). The brief keeps cron + source-file signals, but the
gate becomes: a deterministic pre-pass compares stored fingerprints against
current inputs; **only stale blocks get model turns**; all-fresh fires are
zero-model, zero-effect no-ops. Cap: 3 model re-composes per day (info
diagnostic beyond). Replaces the bespoke sources-seen gate with the general
rule: *the model re-runs exactly when its inputs materially changed.* Fixes
the observed 06-30 staleness: a mid-morning foreground calendar commit →
signal → fingerprint mismatch → meetings+today re-compose, with the
deterministic agenda already on the page since the file landed.

## Section 4 — Degradation ladder (updated rungs)

| Missing input | Behavior |
|---|---|
| No model provider | Daily still carries agenda + questions + integrated + sources + open-loops + skeleton — a useful morning package with zero model. Brief stays a clean no-op. |
| `questions.read` declared, store unavailable | Runtime warning diagnostic + questions block omitted. Loud, never silent — this rung was the original bug. |
| No calendar file | Agenda omitted; sources line renders `calendar —` honestly; when the file lands, the signal renders the agenda within one tick, no model needed. |
| compose-blocks run fails | Deterministic ⇒ failure is a bug: run-ledger failure path, quarantine after 3 consecutive failures per trigger, existing health question. Patch is atomic — never a half-written package. |
| Brief fails mid-flight | Existing failure-stub contract unchanged; blast radius shrinks (deterministic blocks already on the page from 05:25). |
| Re-compose cap exhausted | Deterministic blocks keep updating live; model narrative freezes for the day + info diagnostic. |

## Section 5 — Spec, grant, test changes

**Specs first:** [[wiki/specs/daily-surface]] — choreography (+05:25 row),
section-contract + block-ownership tables (four new `dome.daily:*` rows;
`brief:questions/integrated/sources` → retired-legacy), degradation ladder,
wake-tick section rewritten around fingerprint gating.
[[wiki/specs/autonomous-agents]] — slimmed brief charter + fingerprint
contract. [[wiki/specs/processors]] / [[wiki/specs/processor-execution]] —
the `questions.changed` signal kind. [[wiki/specs/capabilities]] —
`questions.read`. [[wiki/specs/task-lifecycle]] §generated-block grammar —
the `inputs=` attribute.

**Grants:** `dome.daily` gains `questions.read` + the compose-blocks patch
entry; manifest `doctor.grantEntries` updated in the same change (existing
vaults get the exact YAML from doctor; the work vault needs the one-line
grant addition).

**Tests:** per-renderer units (empty/present/removal/cap); signal emission
(ask → one signal per tick; resolve → signal; no mutation → none);
`ctx.questions` capability enforcement + loud-on-missing diagnostic;
fingerprint gate (unchanged inputs → zero model invocations — structural,
processor-purity style); marker migration (today-only, idempotent,
historical dailies untouched); wake-tick ordering (05:25 before 05:30 in a
collapsed burst); no-model integration test asserting the full deterministic
package.

## Section 6 — Rollout

1. Engine surface (signal + `ctx.questions` + marker attribute) — inert
   until consumed.
2. compose-blocks + slimmed brief + specs + grants on one branch
   (`compiled-daily/build`), merged `--no-ff` — splitting would create a
   two-writer window on integrated/sources.
3. Work vault: add the grant, restart the daemon, watch one real morning.
   First observable wins: the 10 idle questions appear under "To decide"
   same-day; the agenda renders the moment a calendar file lands.

No PWA changes — it already reads the projection-backed today view; this
brings the desktop daily to parity.
