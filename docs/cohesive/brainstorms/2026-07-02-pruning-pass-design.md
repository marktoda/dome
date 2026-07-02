---
type: brainstorm
tags:
  - design
  - pruning
  - economics
  - engine
  - daily
created: 2026-07-02
updated: 2026-07-02
status: design-approved
sources:
  - "[[cohesive/brainstorms/2026-07-01-product-review-round-2-compiled-daily]]"
  - "[[cohesive/brainstorms/2026-07-02-intake-close-design]]"
  - "[[wiki/specs/task-lifecycle]]"
  - "[[wiki/specs/claims]]"
  - "[[wiki/specs/effects]]"
  - "[[philosophy]]"
---

# The pruning pass — subtraction, evidence-backed

Approved design, 2026-07-02. Executes the round-2 review's pruning table:
the deletion test already ran in production (attention-discount quarantined
13+ days, zero felt loss), model spend doubled WoW ($21.64 → $44.01) with
the top-3 spender's output rendering nowhere, and the ledger is ~97% no-op
rows. Owner decisions taken: warden folds into consolidate; staleness
becomes overdue-only; current-facts digests survive on entity pages only.

Unlike the last two projects this is mostly subtraction across live
machinery: each item's deliverable is a *degradation story* (what replaces
the deleted signal), not new surface.

## 1. Warden folds into consolidate; `dome.warden` retires

The nightly `dome.agent.consolidate` charter absorbs integrity review: its
janitor turn additionally flags internal/cross-page contradictions and
completed-events-framed-as-ongoing, emitted as `info`/`warning` diagnostics
(the questions-as-decisions contract: findings you fix by editing,
self-clearing via `resolveStaleDiagnostics`). Model judgment stays
transient — no facts, no auto-patches beyond consolidate's existing
propose-not-auto envelope. Cost rides consolidate's existing budget and
nightly cadence: integrity checking at marginal cost on a run that already
reads the same pages, instead of 412 per-change runs/14d at $13.69.

Deletions: `assets/extensions/dome.warden/` (bundle, manifest, processors),
default-config stanza, matrix rows, warden tests (charter assertions move
to consolidate's), spec references (`autonomous-agents.md` §consolidate
gains the integrity clause; warden sections retire). Vault rollout removes
the `dome.warden` config stanza.

## 2. Stale-task machinery collapses to warden + answer (overdue-only)

Staleness = **overdue ≥ 14 days, period**. Undated tasks stop being
settle-question candidates; they rank by recency in open-loops until dated
or settled. Deletions:

- `dome.daily.attention-discount` processor + `attention-shared.ts` +
  `dome.attention.*` facts/grants/doctor-entries.
- Discount consumption in `carry-forward` / `today` / `prep` /
  `agenda-with` ranking (recency penalty term drops; ranking = due-date
  then recency).
- `stale-task-warden`'s undated+discount eligibility path (overdue-only
  remains); `settle-stale-answer` unchanged.
- The brief already lost its stale-loops read (compiled-blocks Task 8).

Degradation story: repeated-dismissal demotion disappears — accepted; 13
quarantined days proved nothing depended on it. `📅`/`🔺` semantics
untouched. [[wiki/specs/task-lifecycle]] rewritten in place (the
attention-discounting sections retire; AC3: any `enforced_by` tests for
discount invariants retire with their invariant docs or re-point).

Rollout note: the two open quarantine-recovery questions (ids 2, 3) and
the `quarantined.json` rows reference the deleted processor — the plan
must determine the clean order (resolve-then-upgrade vs. state cleanup
probe) rather than leave orphaned state.

## 3. `current-facts` charter: external-only, entities-only, capped

`dome.claims.render-facts` changes charter:

- **Scope: `wiki/entities/**` only.** Digests elsewhere are removed by the
  same migration pattern compose-blocks used (today-forward removal of the
  block on non-entity pages when next touched — verify feasibility; if
  per-page-touch removal churns worse than a one-shot sweep, the plan may
  choose one deliberate cleanup patch per page batch).
- **Content: claims whose source is a DIFFERENT page than the one being
  rendered** — "what the rest of the vault says about this subject" —
  never a restatement of the page's own body. Placeholder laundering dies
  structurally (placeholders live in the page's own body).
- **Cap:** 12 bullets, most-recent-first, `+N more — dome query <subject>`
  tail (mirror the To-decide cap pattern).

`stamp` and `index` (the identity + retrieval layers) are untouched —
anchors are self-limiting churn; the digest was the firehose.
[[wiki/specs/claims]] rewritten accordingly.

## 4. Health trio: store-change signals at N≥3 (the descoped gate, designed once)

Generalize the `questions.changed` pattern (shipped in compiled-blocks):

- **`outbox.changed`** — emitted at the outbox store's mutation chokepoints
  when a row enters/leaves a recovery-relevant state (`failed`,
  stuck-`pending`); `dome.health.outbox-recovery-questions` subscribes,
  per-minute cron dropped.
- **`quarantine.changed`** — emitted on quarantine insert/reset;
  `quarantine-recovery-questions` subscribes, cron dropped.
- **Orphan runs are absence, not change** — no signal can fire on a row
  that stopped moving. `orphan-run-recovery-questions` keeps a cron,
  demoted per-minute → hourly (orphans are crash artifacts; an hour's
  detection latency is fine and the recovery is human-gated anyway).

Same dispatch channel and vocabulary rules as `questions.changed` (Signal
union + zod + manifest subscription; synthesized TriggerMatches, no
compileRange). Effect: ~60k rows/14d → ~350. The answer-handler halves of
the trio are untouched. `dome.sources.fetch`'s 15-minute poll (~1.4k
rows/14d) is **explicitly retained**: its cron is the due-check/retry
granularity the 05:10 subscription needs, and inventing config-conditional
trigger registration for one consumer re-enters the N=1 trap this section
escapes.

## 5. Dead vocabulary

- **JobEffect dies:** the effect kind, `job.enqueue` capability, `job`
  trigger kind, zod schemas, engine routing arm, `scheduled_jobs` table +
  jobs runner (`src/engine/operational/jobs.ts`), spec section, and tests.
  Zero users were verified in the July 1 audit. (Type unions + exhaustive
  switches shrink; the schema-lockstep and capability-count tests update.)
- **Retired daily-block render helpers** (`carriedForwardSection`,
  `replaceCarriedForwardSection`) deleted per daily-surface.md's own
  "deletable whenever convenient"; marker recognition entries stay.
- **`log.md`**: SDK-side, verify the init template/docs no longer imply it
  updates (his vault already archived it); retire stale references only —
  no file moves in vaults.

## Cross-cutting

- Spec-first per repo discipline; every retirement follows the doc-sweep
  rule (normative pages rewritten in place; historical brainstorms
  untouched).
- Expected outcomes, measured at the next weekly audit: LLM spend roughly
  halves (warden gone, digest churn scoped down); engine-commit churn
  drops by the render-facts share; ledger rows drop ~95%; three processors
  and one bundle fewer to explain to a second user.
- Rollout: vault config sweep (warden stanza out, `dome.attention.*`
  grants out), daemon restart, projection rebuild (clears `dome.attention.*`
  and non-entity digest facts), stale-state cleanup per §2's note, one
  observed morning.
