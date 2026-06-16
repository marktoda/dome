---
type: brainstorm
tags: [design, cli, daily, cockpit, readability]
created: 2026-06-15
updated: 2026-06-15
status: approved-design
sources:
  - "[[cohesive/brainstorms/2026-06-15-dome-today-readability]]"
  - "[[cohesive/brainstorms/2026-06-15-daily-phase2]]"
---

# dome today — render-time entity grouping (Approach A)

Approved design, 2026-06-15. Follows the daily Phase 2/3 work. The remaining
readability pain: a cluster of related tasks (the routing-retention pile —
Cody/Siyu/Charles across ~4 overdue lines) reads as scattered lines the owner
must mentally re-assemble. **Approach A** (chosen over a durable clustering
warden, B): group them at render time in `dome today`. Presenter-only, no
durable mutation, no meaning-loop — the same family of change as the existing
`OVERDUE/TODAY/OPEN` section grouping.

## Signal
Tasks carry `[[entity]]` wikilinks (people/topics). `today-view` currently
`stripWikilinks`-es the row text before the renderer sees it, so the grouping
signal is lost. Fix: `today-view` parses the `[[…]]` targets out of the raw row
text *before* stripping and exposes a structured `entities: readonly string[]`
on `TodayTaskRow` (the last-path-segment slug of each wikilink, matching how
`stripWikilinks` renders them). Mirrors how `origin` became a structured field.

## Grouping algorithm (presenter, in `formatTodayResult`)
Operates *within* each bucket (OVERDUE / TODAY / OPEN), on the **shown** tasks
(post-cap), so the `… N more` overflow stays honest:
1. Count, across the bucket's shown tasks, how many share each entity slug.
2. An entity shared by **≥ CLUSTER_MIN (3)** shown tasks is a *cluster*.
3. Each task joins the cluster entity it shares with the most members
   (dominant; ties → alphabetical by slug). Tasks with no qualifying shared
   entity stay ungrouped.
4. Render order within the bucket: clusters first (each: a sub-header
   `  <entity>  (N)` then its members indented one extra level), then the
   ungrouped tasks flat. Per-line trailing entity labels (the other shared
   entities) still render, so cross-links stay visible.

The sub-header is the **single dominant entity slug** (deterministic — no
synthesized theme name, which would need model judgment).

## Boundaries / cohesion
- **Presenter + one structured field only.** `today-view` gains `entities`;
  `today.ts` gains a grouping pass. No processor, no fact, no durable mutation.
- **Width invariant holds:** grouped members get one extra indent level; that
  indent is reserved in the `shortenLabel` width math (members' `taskWidth` is
  reduced by the indent), so no line exceeds `caps.width`.
- **Caps + `--verbose` unchanged:** grouping arranges the already-shown set;
  the per-bucket cap and overflow line are computed as today. Under `--verbose`
  (uncapped) the same grouping applies to the full set.
- **Hero, ask line, all-clear, calendar, brief blocks unchanged.**
- **HTML cockpit unaffected:** the change is in the CLI renderer + the shared
  `today-view` adds an OPTIONAL field; the HTML surface ignores it.

## Defaults (owner-approved)
- CLUSTER_MIN = 3 shared tasks.
- Sub-header = dominant entity slug + `(N)` count.
- Shown-grouped (all members visible under the header), not collapsed-to-summary.

## Non-goals
- No durable clustering / umbrella pages / clustering warden (Approach B,
  deferred — revisit from evidence if visual grouping proves insufficient).
- No theme naming (deterministic slug header only).
- No cross-bucket grouping (a cluster spanning OVERDUE+TODAY is not merged).

## Testing
- `today-view`: `entities` parsed from `[[a]] [[b|c]] [[dir/d]]` → `["a","c","d"]`;
  absent → undefined/empty; text still stripped.
- `formatTodayResult`: ≥3 shared-entity tasks in a bucket → sub-header + indented
  members; <3 → flat (no header); ungrouped tasks render after clusters; a task
  with multiple shared entities joins the larger cluster; width-bound holds at
  narrow widths with the extra indent; `--verbose` groups the full set.
