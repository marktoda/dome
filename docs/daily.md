---
type: plan
tags:
  - daily
  - roadmap
  - surfaces
created: 2026-06-10
updated: 2026-06-10
status: plan-of-record
sources:
  - "[[wedge]]"
  - "[[memory]]"
  - "[[wiki/specs/task-lifecycle]]"
  - "[[wiki/specs/autonomous-agents]]"
---

# Daily-surface plan — the day's console, three acts

Plan of record as of 2026-06-10. The daily note is the one file where the
system and the owner meet. A full read-through found the *mechanism* layer
coherent (disjoint splice-guarded block ownership, correct degradation,
move-stable task identity) but the *product* layer accreted across five build
efforts. This plan makes the daily a deliberate package without touching the
load-bearing bundle split (dome.daily = deterministic, dome.agent = model —
that boundary stays).

## The frame

The daily has exactly three jobs:

1. **Morning Edition (02:00–06:00, compiled)** — consolidate → sweep →
   calendar → *edition compile*. One pipeline, one output, explicit
   degradation ladder.
2. **Live Surface (daytime)** — capture lands in an owned block; hygiene
   invisible; today/prep/agenda are projections.
3. **Close (evening)** — currently unowned; becomes first-class. The close's
   outputs are the next edition's inputs; skipping it degrades visibly.

## Accretions being fixed

- Two "yesterday" summaries (`dome.daily:start-context` mechanical vs
  `dome.agent.brief:yesterday` LLM) side by side under `## Start Here`.
- `## Captured today` exists in real vaults but not the skeleton; ingest
  appends task lines outside any owned block.
- No evening machine: `Done`/`Decisions`/`Story` feed tomorrow's edition but
  only fill if a vault-side ritual runs; skipping silently degrades tomorrow.
- The pipeline exists only as scattered cron strings; no single health answer.
- No written section contract — why duplicates and drift creep in.
- `/morning` (vault ritual) and the brief overlap in `## Meetings` undesigned.

## Phases

Spec-first per phase; full suite stays 0 fail. D1 → (D2 ∥ D3) → D4 → review →
main → vault rollout.

### D1 — The contract: daily-surface spec + edition loop

- New normative spec `wiki/specs/daily-surface.md`: the section schema (every
  `##` heading's job, owner, machine reader), the block-ownership table, the
  three acts, the edition's degradation ladder, and the choreography diagram
  (02:00 → 06:00 with triggers). Existing scattered content in
  task-lifecycle/autonomous-agents gets pointers, not duplication.
- The **edition as a named maintenance loop** (`dome.daily.edition` or
  similar) in the loops inventory, with doctor choreography checks: calendar
  source present by brief time (info when absent ≥2 consecutive days),
  edition compiled this morning, carry-forward merged. One status line
  answers "did my morning happen."

### D2 — One yesterday

- `dome.agent.brief:yesterday` absorbs `dome.daily:start-context`: ONE block
  (owner: the edition), where the mechanical "Since Yesterday" extraction is
  the **no-model fallback body** of the same block rather than a sibling
  block. create-daily/carry-forward write the fallback only when the brief
  block is absent; the brief replaces it wholesale. The `start-context`
  marker is retired (migration: brief/create-daily treat an existing
  start-context block as the thing to replace once, then it never reappears).
- Degradation pinned by tests: model present → curated; model absent →
  mechanical; neither → section stays empty, never duplicated.

### D3 — Captured today, owned

- Skeleton gains `## Captured today` with an owned block
  (`dome.daily:captured`); ingest's task-routing writes INSIDE it (tool-seam
  enforced, like the signals append guard); `dome capture`-originated tasks
  land there with their anchors. Reconcile/task-index already pick these up —
  verify and pin.
- Heading-duplication repair: normalize-task-syntax (or a small lint) heals
  the known real-vault wart of duplicate `# Captured today` headings into the
  owned section.

### D4 — The Close

- New deterministic garden processor (`dome.daily.close-scaffold`, cron
  ~21:30 local): drafts a `dome.daily:close` block under `## Done` — Done
  candidates derived from the day's settled tasks (reconcile activity) and
  engine ledger, plus an "unfinished from today" line-up; `Story of the Day`
  stays purely human. One glance + optional `/eod` enrichment confirms.
- The next morning's edition reads the close block (richer mechanical
  fallback for "yesterday"); a skipped close yields an explicit "yesterday's
  close was empty" line instead of silent thinness.

### D5 — Fold the rituals (vault-side, after dogfood)

- `/morning`'s per-meeting prep depth → edition charter (meetings bullets
  gain talking-point digests when vault context warrants).
- Overnight Slack digest → committed-source adapter recipe (calendar
  pattern). Then `/morning` retires or shrinks to enrichment.

## Non-goals

- Merging dome.daily and dome.agent bundles (trust boundary stays).
- New Effect kinds, new engine primitives, model-written close content.
- Touching the sweeper's "Integrated overnight" block (already edition-shaped).

## Decision ledger

1. Cohesion lands at the spec/surface layer, not the bundle layer.
2. One yesterday-block with a degradation ladder beats two parallel blocks.
3. The close is deterministic scaffold + human story — never model prose.
4. Section contract is normative; future daily writers must claim a row.
