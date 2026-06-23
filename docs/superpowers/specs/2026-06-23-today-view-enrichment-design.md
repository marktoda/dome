---
title: today view enrichment — brief by default, calendar agenda, priority markers, hero retired
date: 2026-06-23
status: design
topic: today-view-enrichment
sources:
  - "[[wiki/concepts/surface-view-model]]"
  - "[[wiki/specs/daily-surface]]"
  - "[[superpowers/specs/2026-06-14-cockpit-briefing-design]]"
  - "[[superpowers/plans/2026-06-22-today-view-model]]"
---

# today view enrichment — brief by default, calendar agenda, priority markers, hero retired

## Problem & context

`dome today` renders the daily action surface through the three-tier
surface-view-model ([[wiki/concepts/surface-view-model]]): the producer
(`assets/extensions/dome.daily/processors/{today,action-state}.ts`) emits the
`dome.daily.today/v1` payload, `src/surface/today-view.ts` validates it and
derives a view-model (`buildTodayViewModel`), and two adapters paint it — the
CLI (`src/cli/commands/today.ts`) and the HTTP cockpit
(`src/http/today-html.ts`).

The producer computes far more than the CLI paints. Several rich fields die at
the contract boundary or in the view-model:

| Field computed by producer | In wire contract? | Painted by CLI? |
|---|---|---|
| `text`, `path`, `line`, `dueDate`, `origin` | yes | yes |
| `priority` (🔺⏫🔼🔽⏬ → highest…lowest) | no (stripped) | no |
| `attention` (discount, impressions, lastShown) | no | no |
| `source` (daily vs backlog), `followup` | no | no |
| `calendar.events` | yes (in model) | **count only — events discarded** |
| `brief` (2–3 sentence framing) | yes (in model) | **hidden behind `--verbose`** |

This spec surfaces three of them and retires a fourth concept (the hero) that is
not pulling its weight. All four changes route through the shared view-model so
the CLI and HTTP cannot drift on what a value *means*.

### Why retire the hero

`selectHero` (`action-state.ts:156`) is a strict ladder: highest-ranked
non-zombie overdue task → first `owner-needed` question → soonest-due task →
null. `heroRank` (`action-state.ts:181`) is **only** the priority-emoji weight,
and `null` priority → 0. Since almost no tasks carry a priority emoji, every
candidate ties at rank 0; the stable sort then breaks the tie by the producer's
pre-sort, which for overdue tasks is due-date **descending** — i.e. the
*least*-overdue daily-note task floats to the top. The hero is therefore
well-defined but weakly-signalled: on an ordinary day it manufactures a "most
important" item out of noise, which reads as a random TODO and trains the user
to ignore it.

The deeper issue is that the hero is **forced**: `selectHero` returns `null`
only when there are literally zero eligible dated tasks and zero owner-needed
questions. But a genuine "this, first" is *not always* present. A forced
one-thing that is usually noise is worse than no one-thing — especially now that
the brief occupies the top slot with grounded prose.

**Decision: retire the hero as a surfaced concept for now; park (do not delete)
the machinery for a later, confidence-gated revival.** The brainstorm sketched
the revival gate (precision-first: show a hero only when a ▲▲/▲-tagged non-zombie
task or an `owner-needed` question clears the bar, never plain overdue-ness);
that thinking is preserved here for the follow-on, but is explicitly **out of
scope** for this spec.

## Goals

- Surface the morning **brief** by default in the CLI (it is already grounded,
  short, and validated).
- Render the **calendar agenda** (events the model already carries) instead of a
  one-line count.
- Surface **task priority** (all five levels) as a marker in both adapters.
- **Retire the hero** at the view-model and both paints, correctly (so no task
  vanishes), while leaving the producer's `selectHero` and the wire `hero`
  dormant for later revival.

## Non-goals

- Designing the earned-hero revival gate (its own follow-on spec).
- Surfacing `attention`/`source`/`followup`/`evidenceLabel` (separate
  enrichments; not in this pass).
- Any change to the producer's selection/sort logic, the projection store, or
  the brief composer.

## Layout

Chosen vertical order (the "editorial" order, hero removed):

```
verdict header
brief                 (default; wikilinks stripped; wrapped)
agenda                (time-gutter; calendar events)
sections              (OVERDUE / TODAY / THIS WEEK / LATER / SOMEDAY)
… overflow line
? ask line
rollup
```

Worked example:

```
dome today · work                                    ✗ 14 overdue · 269 open

  RH Chain launch catalog is today's critical path; legal scoping with
  Andrew Pai gates further code. Erin promo doc deferred to next week.

  agenda  2026-06-23
    09:00  Partner sync — RH Chain          Cody, Grayson
    14:00  Legal scoping w/ Andrew Pai

  OVERDUE
  ✗ ▲▲ Partner call: confirm RH Chain launch-day token catalog   overdue 2026-06-11…
  ✗ ▲  Post the model spec + de-risk findings to #proj-thesis-vaults
  ✗    Legal scoping w/ Andrew Pai: vault-token securities characterization…
  ✗ ▽  Re-look Erin promo doc (deferred to next week)
  SOMEDAY
  • Resolve Bobby Pratt vesting date   ↗
  … 7 more overdue · 251 more · dome today --verbose
  ? ask   #3158 Stale overdue task (due 2026-06-09, 14d overdue)…   dome resolve 3158 <…>

  ✓ everything else clean
```

## Components

### 1. Retire the hero (tier 2 + tier 3)

The hero is not merely *rendered* separately — `buildTodayViewModel`
(`today-view.ts:363-364`) **deduplicates** it out of the section lists so it is
not shown twice. Removing only the paint would make the deduped task vanish.
Retiring the hero is therefore a view-model change first.

- **View-model (`today-view.ts`):**
  - Drop hero-dedup: `buildTodayViewModel` partitions **all**
    `[...openTasks, ...followups]` into the five urgency sections (no `heroKey`
    skip).
  - Remove `hero` and `heroUrgency` from `TodayViewModel`. (`TodayHeroItem`,
    `parseHero`, and the wire `hero` field stay — see "park, don't delete".)
- **CLI (`today.ts`):**
  - Delete the hero block (`formatTodayResult` lines ~351-398) and
    `heroUrgencyStrings`.
  - Fix the verdict overdue-count: it currently adds the hero-if-overdue
    (`overdueCount = stillOpen.overdue.length + (heroUrgency overdue ? 1 : 0)`).
    With no hero, `overdueCount = stillOpen.overdue.length`.
  - Fix the overflow math: `trueTotal` currently subtracts the hero-if-task
    (`- (heroIsTask ? 1 : 0)`); drop that term.
- **HTTP (`today-html.ts`):** delete the hero pill (`renderHeroHtml`, the
  `.hero*` CSS, the `heroIsTask`/`trueOpenCount` hero adjustment), and remove
  `hero`/`heroUrgency` from the destructure. The "Still open" true-count drops
  the hero subtraction.
- **Park, don't delete:** the producer's `selectHero` (`action-state.ts`) and
  the wire `hero` field (`todayPayloadSchema`) are left intact and dormant. The
  payload still carries a `hero`; the view-model simply no longer exposes it.
  Reviving an earned hero later is a view-model + paint change, not a rebuild.

### 2. Brief by default (tier 3, CLI paint)

The `dome.agent.brief` fact text is a "warm, forward-looking 2–3 sentence
framing of today" (`brief.ts`), grounded with `[[wikilinks]]` (ungrounded
bullets are stripped and re-asked). It is already in the view-model
(`vm.brief`), gated behind `--verbose` in the CLI.

- Render `brief.text` directly under the verdict header, before the agenda.
- Strip `[[wikilinks]]` to their labels for terminal legibility, reusing
  `stripWikilinks`/the inline-link handling the task rows already use. Wrap to
  `caps.width` with the standard 2-space indent (`wrap` from the presenter).
- `--verbose` additionally prints the `brief.sourceRef.path` line (today's
  `--verbose` brief behavior). When the brief is shown by default, drop the
  "--verbose for full brief + sources" nudge.
- No brief → no block (unchanged null-handling).
- HTTP already renders the brief; no change.

### 3. Calendar agenda (tier 3, CLI paint)

`vm.calendar.events` (`{time, title, meta}`) is already in the model; the CLI
(`today.ts:408-416`) collapses it to `today <date> · N events` and discards the
events.

- Replace with a labeled agenda block: an `agenda  <date>` header, then one row
  per event — a fixed-width time gutter, the title, and the dim `meta`
  (attendees) as a trailing detail when non-empty.
- Cap at 5 events with a `… +N more` line (consistent with the section caps);
  `--verbose` shows all.
- Untimed events (empty `time`) sort first (matches the producer's sort) and
  render with a blank/`—` gutter.
- No calendar / no events → no block (unchanged null-handling).
- HTTP already renders the full agenda; no change.

### 4. Priority markers — all five (tier 1 + tier 2 + tier 3)

The producer parses priority (`taskPriority`, `action-state.ts:996`) and strips
it from display text, using it only for the (now-retired) hero rank. Surface it.

- **Tier 1 (contract):** add `priority` to `taskRowWireSchema` and
  `TodayPayload` —
  `priority: z.enum(["highest","high","medium","low","lowest"]).nullable().optional()`.
  The producer already carries `priority` on `DailyTaskItem`; it flows through
  the `openTasks`/`followups` spread, so emitting it is a one-field addition to
  the `satisfies TodayPayload` shape (compile-checked).
- **Tier 2 (view-model):** add `priority` to `TodayTaskRow`; `parseTaskRows` and
  `parseHero`'s task branch read it null-safely (validate against the five
  literals, else `null`).
- **Tier 3 (paint):** between the status glyph and the text, render a marker:
  `▲▲` highest, `▲` high, (blank) medium/none, `▽` low, `▽▽` lowest. Highest/high
  painted with the `err` tone, low/lowest with `muted`, medium/none blank. The
  marker occupies a **fixed-width gutter** (the width of `▲▲` + a space) so it is
  reserved out of the row's text budget and the row-width invariant holds; the
  ASCII fallback uses `^^`/`^`/`v`/`vv`. HTTP renders the same marker as a span
  before `.open-text` with matching colors.

## Data flow

```
producer (dome.daily)            contract + model (today-view.ts)        paint
─────────────────────            ────────────────────────────────       ─────
DailyTaskItem.priority  ──▶  taskRowWireSchema.priority (tier 1)
                             TodayTaskRow.priority      (tier 2)   ──▶   ▲▲/▲/▽ (CLI + HTTP)
DailyHero  ──(dormant)──▶     payload.hero  (kept, NOT exposed by view-model)
calendar.events         ──▶  TodayViewModel.calendar    ──▶   agenda block (CLI)
brief                   ──▶  TodayViewModel.brief        ──▶   default brief (CLI)
[...openTasks, followups] ─▶ TodayViewModel.stillOpen (no hero-dedup) ─▶ sections
```

## Error handling & edge cases

- **Hero removal must not drop a task.** Covered by stopping the dedup in the
  view-model (Component 1). A view-model test asserts that a task the old
  `selectHero` would have promoted now appears in its urgency section.
- **Verdict/overflow counts** must stay exact with no hero — the two
  hero-adjustment terms in `formatTodayResult` are removed (Component 1).
- **Priority parse resilience:** `parseTodayView` stays total; an unknown
  priority string → `null`, never a throw.
- **Width invariant:** the priority gutter and agenda time gutter are reserved
  out of the text budget; existing width tests extend to cover marked rows and
  agenda rows.
- **`--json`** emits the validated payload unchanged (priority now present;
  `hero` still present in the payload — dormant, not removed).

## Testing

- **View-model (`tests/.../today-view*`):** no hero exposure; all open
  tasks/followups land in sections (the "no task vanishes" assertion); `priority`
  parsed for all five literals + null + unknown→null.
- **CLI (`tests/.../today*`):** brief shown by default (wikilinks stripped),
  source path only under `--verbose`; agenda renders events with time gutter +
  meta + cap/overflow; priority markers render at the right levels with correct
  tones and reserved width; verdict + overflow counts exact with no hero.
- **HTTP (`tests/.../today-html*`):** no hero pill; priority span renders;
  "Still open" count exact.
- **Contract:** producer payload still `satisfies TodayPayload` with `priority`;
  schema accepts the new field and still strips extras.

## Open questions

None blocking. Deferred by decision: the earned-hero revival gate (own spec);
surfacing `attention`/`source`/`followup`.
