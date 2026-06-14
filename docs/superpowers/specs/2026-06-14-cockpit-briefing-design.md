---
title: Cockpit "Briefing" — daily brief surface (web + terminal)
date: 2026-06-14
status: design
topic: cockpit-briefing
sources:
  - "[[cohesive/design-assets/cockpit-briefing/briefing.dc.html]]"
  - "[[cohesive/design-assets/cockpit-briefing/design-chat.md]]"
  - "[[wiki/specs/daily-surface]]"
  - "[[wiki/specs/http-surface]]"
  - "[[superpowers/specs/2026-06-14-cli-output-density-v2-design]]"
---

# Cockpit "Briefing" — daily brief surface (web + terminal)

## Problem & context

The `/today` cockpit (web) and `dome today` (terminal) both render the daily
action surface, but the web page is a plain dark list with no design attention,
and neither shows the richer "morning brief" the user wants. The user mocked up a
redesign with Claude Design and chose **Direction B — "Briefing"** (bundle
preserved at `docs/cohesive/design-assets/cockpit-briefing/`): a warm 2–3
sentence narrative at the top, then structure (calendar, questions, open tasks),
in a calm dark visual system, with a matching terminal.

Three design questions raised during brainstorming, and the resolutions:

1. **Reuse the daily note's brief, don't re-run an LLM per refresh.** Adopted.
   `dome.agent.brief` already composes the daily note every morning; we add one
   forward-looking narrative block and surface it as a **fact** the cockpit reads.
2. **`dome decide` is unnecessary — drop it.** It only existed as the terminal
   mock's invented next-action. The real decision command is `dome resolve`.
3. **Interactivity through the existing HTTP mutation surface.** `POST /resolve`
   and `POST /capture` already exist; the cockpit answers questions and captures
   notes directly, loosely coupled to the foreground agent *through the vault*.

## Architecture principle — structure ownership & fact contracts (load-bearing)

This is the principle the whole design must obey (a self-review of an earlier
draft found it had been violated):

- **The daily note's structure has exactly two kinds of owner per region:** the
  skeleton owner (`renderDailySkeleton` in `dome.daily`, which lays down the
  sections + the captured-block markers) and, per generated block, the single
  **owning processor** that writes it via the shared marker contract
  (`generatedBlockMarkers(owner, block)` → `<!-- dome:start owner:block -->…`,
  located/extracted/replaced via `src/core/generated-block.ts`).
- **Consumers never parse another bundle's markdown.** Cross-processor
  communication goes through **facts / projections**, never by re-reading each
  other's note prose. The today view already follows this: it assembles from
  facts (`dome.daily.task-index` emits `dome.daily.open_task` facts; the view
  reads those + `projection.questions`) — it does **not** scrape the note's task
  lines.
- **Therefore:** every new thing the cockpit shows is produced by its owning
  bundle as a **fact** during adoption, and the today view is **pure
  fact-assembly**. A note block is the *human render*; the fact is the *machine
  contract*. This keeps assumptions about the note in governed places only, makes
  the view re-render-proof, and makes the surface extensible (new block → owner
  emits a fact → view picks it up, zero view changes).

## Chosen direction (decided 2026-06-14)

- **Briefing layout (Direction B)** — one responsive web page (phone + desktop)
  + a matching terminal `dome today`.
- **Brief sourced from a fact** emitted by `dome.agent` from its own brief block —
  no per-refresh model call, no cross-bundle markdown parsing.
- **No `dome decide`.** Hero next-action is the most-urgent item itself (task
  highlighted, or `dome resolve` when it's a question).
- **Interactive: answerable + capture.** Tap a question option → `POST /resolve`;
  a capture box → `POST /capture`; tap-to-reveal the `dome resolve` command as
  fallback.
- **JS polling (not meta-refresh).** The page fetches the today JSON on an
  interval, so "live" / "reconnecting" states are real. (SSE server-push remains
  out of scope.)
- **Calendar is best-effort, foreground-fed.** The foreground agent writes
  `sources/calendar/<date>.md`; `dome.agent` emits calendar facts when the file
  is present; the cockpit renders the timeline when facts exist and omits it
  cleanly otherwise. No daemon calendar fetcher in scope.
- **"Keeping in mind" is dropped** from this build (no governed source yet).
- **Hero is optional + discount-aware.** Computed from facts (open-task facts +
  `dome.attention.discount` + questions); respects attention discounting so it
  never blares a dismissed zombie; trivially droppable if it reads noisy.
- **System fonts**, faithful colors/layout/spacing; **self-contained page**
  (no external assets), dark only.
- **Query-token authorizes mutations** (resolve/capture from the page). Accepted
  for the loopback/trusted-LAN posture; the trust boundary is documented in
  `http-surface` (anyone with the `/today?token=` URL can now write, not only
  read).

## Data layer — the today view becomes pure fact-assembly

Extend the `dome.daily.today/v1` document
(`assets/extensions/dome.daily/processors/today.ts` + `action-state.ts`) with
**additive** fields, each assembled from **facts** (no markdown parsing in the
view). Existing fields (`openTasks`, `followups`, `questions`, `counts`,
`dueCounts`, …) are unchanged.

```
brief:    { text: string; sourceRef: SourceRef } | null
calendar: { events: ReadonlyArray<{ time: string; title: string; meta: string }>;  // meta: "" when none
            sourceRef: SourceRef } | null
hero:     { kind: "task"; item: DailyTaskItem }
        | { kind: "question"; item: DailyQuestionItem }
        | null
```

(No `keepingInMind` — dropped.)

- **`brief`** — read the `dome.agent.brief` **fact** (§ brief). `null` when the
  fact is absent (pre-compose / model off). The view never touches the brief
  block's markers or prose.
- **`calendar`** — read `dome.agent.calendar.event` **facts** (§ calendar).
  `null`/empty when none. The view never opens `sources/calendar/*`.
- **`hero`** — computed in the view from facts already in hand: candidate set =
  open-task facts (minus attention-discounted ones) + unresolved questions.
  Precedence: most-urgent **non-discounted** overdue task (weighted by priority,
  not raw overdue-days) → top `owner-needed` question → soonest-due / highest
  priority task → `null`. Discount-aware by construction; optional.

Questions in "Dome needs you" remain the unresolved set, `owner-needed` first.

## Brief — `dome.agent` owns block + fact

In `dome.agent` (`processors/brief.ts` + `lib/brief-shared.ts`):

1. **Compose block** `dome.agent.brief:today` — a model-written, grounded (every
   claim carries a `[[wikilink]]`), warm 2–3 sentence framing of *today*, spliced
   at the top of `## Start Here` during the 05:30 compose + late-source
   wake-ticks (same pass + grounding/degradation machinery as the existing
   blocks). Model unavailable → block omitted (no fallback prose).
2. **Emit fact** — an **adoption-phase extractor** (owned by `dome.agent`,
   mirroring `dome.daily.task-index`) reads *its own* `dome.agent.brief:today`
   block from the adopted note via the shared `findGeneratedBlock` /
   `extractGeneratedBlockBody` API, strips `[[wikilink]]`/`[[path|alias]]` markup
   and stray markdown to plain prose, and emits a `dome.agent.brief` `FactEffect`
   (`text`, `sourceRef`, date). The fact is a pure function of the adopted
   markdown → rebuildable (correct layering). Block absent → no fact.

The today view reads the fact. No consumer parses the block.

## Calendar — best-effort facts from the foreground-fed source

Calendar is foreground-managed (the foreground agent writes
`sources/calendar/<date>.md`; there is no daemon fetcher). `dome.agent` owns
calendar-fact emission: an adoption-phase extractor over
`sources/calendar/<date>.md` (reusing the existing defensive parser in
`brief-shared.ts` — cap 20 events, time + title + attendees) emits
`dome.agent.calendar.event` facts when the file is present. The today view reads
those facts; absent → `calendar: null` → the timeline is omitted. No calendar
parsing lives in the view or in `dome.daily`.

## Web cockpit — rewrite `src/http/today-html.ts` to the Briefing design

One **responsive** page (the mock's phone + second-monitor are the same document
at different widths via CSS — no device frames in the real page). It now **fetches
the today JSON via JS on an interval** (replacing `<meta refresh>`), so it can
show real live/stale state and apply optimistic updates after actions.

**Visual tokens** (from the design; system fonts):
- Background `#0b0b0c` + subtle radial dot-grid (`rgba(255,255,255,0.05) 1px` /
  24px); surfaces `#131313`; cards `#1A1A1A` / inset `#0d0d0d`.
- Fonts: sans `-apple-system, system-ui, sans-serif`; mono
  `ui-monospace, "SF Mono", Menlo, monospace`. Body weight ~485.
- Status colors: ok `#21C95E`, warn `#FFBF17`, error/overdue `#FF593C`, question
  `#3ADCFF`; muted whites for `•`/`○`/secondary.
- Accent pink `#FF37C7` — **whisper only**: brand dot + the single next-action
  pill. Nowhere else.
- Generous radii, soft shadows, the slow `domePulse` on the live dot.

**Structure** (single column on phone; desktop widens to a two-column band):
- Header: `<date>` + "Good morning." + live indicator.
- **Brief** + provenance (`↳ <daily path> · brief`). Omitted when `brief` null.
- **Next-action pill** (`hero`): pink-bordered. Omitted when `hero` null.
- **On your calendar**: time | title | meta timeline. Omitted when `calendar`
  null/empty.
- **Dome needs you**: interactive questions (§ interactivity). Omitted when none.
- **Still open**: glyph-led task list (`✗` overdue / `⚠` today / `•` open),
  source path on hover/tap. Omitted when none.
- Footer: live indicator + "updated Ns ago".

**Edge states** (rendered from data + fetch status): **all-clear**
("You're clear."), **single item**, **long list** (group overdue/today/this-week,
collapse far future to "+N more"), **stale/reconnecting** (a failed poll: content
dims and holds last-known; a yellow "reconnecting… last updated Nm ago" line owns
the top — now genuinely driven by the JS poll).

## Interactivity (JS; token from `?token=`, sent as a Bearer header)

- **Poll**: fetch `GET /tasks` (the today JSON) every ~15s with the bearer
  header; re-render on success; on failure → stale/reconnecting state holding
  last-known data.
- **Answer a question**: render `options` as buttons → `POST /resolve {id,value}`
  with the bearer header → optimistic removal + toast; suppress re-display of
  just-answered ids until a clean poll (covers the adoption-loop lag); on failure
  surface the error + fall back to the reveal-command.
- **Reveal command (fallback)**: reveal the existing `resolveCommand`
  (`dome resolve <id> <value>`) to copy.
- **Capture**: a "+ capture a thought" control → `POST /capture {text}` →
  confirmation. (Seed of the future voice flow.)
- **Token**: read once from `location.search`; POSTs send `Authorization: Bearer`
  (the query-token escape hatch stays GET-only; POSTs use the header). No new
  routes — `POST /resolve` + `POST /capture` exist as-is.

## Terminal — restyle `dome today` to match (v2 presenter)

Reuse the v2 presenter (`src/cli/presenter/` — verdict header, `signalLine`,
glyphs) for consistency with the shipped CLI. Default compact:

```
dome today · work                      ✗ 1 overdue · 5 open

  → make the routing decision   overdue 4d

  today  Sat Jun 14 · 2 events, both light

  ✗ overdue   Uniroute vs Guidestar — decide w/ Cody
  ⚠ today     Eric "do you want this lane" talk
  • open      Siyu reframing · Guidestar checklist · +1
  ? ask       #7 K-budget gate a blocker?   dome resolve 7

  ✓ everything else clear

  --verbose for full brief + sources
```

- Verdict header; one `→` hero line (task text, or `dome resolve` for a
  question; **never `dome decide`**; omitted if `hero` null); a one-line calendar
  summary (omitted if no calendar facts); glyph-grouped tasks; a single `? ask`
  line.
- **Full brief prose + source paths move to `--verbose`** (v2 density model).
- All-clear variant: verdict + a calm two-line state.

## Scope & non-goals

**In:** the today-view fields + hero (data layer), the `dome.agent.brief:today`
block + its fact extractor, the calendar fact extractor, the web redesign + JS
polling + interactivity, the terminal restyle, edge states, tests, and spec sync
(`daily-surface`, `http-surface`, `cli`).

**Non-goals / deferred:**
- A real **reminders engine** and the **"keeping in mind"** block (no governed
  source; dropped).
- A **daemon calendar fetcher** (calendar stays foreground-fed, best-effort).
- **Voice input UI** (capture box is the seed).
- **SSE server-push** (JS interval polling only).
- **Embedding licensed fonts** (system fonts only).
- No existing `--json` field changes — the today document only **gains**
  `brief`/`calendar`/`hero`; existing fields are byte-stable.

## Sequencing & degradation

- **Sequence the visual cockpit ahead of the brief/calendar facts.** The web +
  terminal redesign must render correctly with `brief`/`calendar`/`hero` all
  `null` (the cockpit is useful without the hero paragraph; it must never be
  broken by an in-flight agent-pipeline change). Land the redesign first reading
  null-safe fields, then add the `dome.agent` fact extractors.
- No calendar facts → calendar section omitted. No brief fact → hero paragraph
  omitted. Empty vault → all-clear. Failed poll → stale/reconnecting holding
  last-known. Page stays self-contained in every state.

## Enforcement (so the structure assumptions don't rot)

- The `dome.agent.brief:today` block is added to the daily-surface block
  inventory + a `daily-surface` spec row + a scaffold/inventory test (the plugin
  already has `daily-captured.test` / `daily-shared.test`).
- The `dome.agent.brief` and `dome.agent.calendar.event` **fact contracts** get
  tests: extractor emits the fact ⇄ adopted block/source (rebuildable), and the
  view assembles the field from the fact.
- The view is tested to contain **no markdown parsing** of foreign blocks/files —
  it reads facts + `projection.questions` only.

## Testing

- **Today view**: per-field unit tests — brief from fact (+ null when absent);
  calendar from facts (+ null); hero precedence incl. **discount exclusion**;
  `--json` additive-only (existing fields byte-stable).
- **Brief**: the `dome.agent.brief:today` block composes/grounds/degrades; the
  extractor emits the `dome.agent.brief` fact from the adopted block with
  wikilink/markdown stripped; rebuildable.
- **Calendar**: extractor emits `dome.agent.calendar.event` facts from a present
  source file; absent/malformed → no facts.
- **Web renderer** (`today-html.ts`): pure-function tests over document → HTML
  for each state (full, all-clear, single, long-list grouping, stale), HTML
  escaping, and that the JS polls `/tasks`, POSTs `/resolve`+`/capture` with the
  bearer header, and reads the token.
- **Terminal**: `dome today` default vs `--verbose`; verdict counts; hero line
  (incl. null-hero omission); no `dome decide`; v2 presenter shape.

## References

- Design bundle (preserved): `docs/cohesive/design-assets/cockpit-briefing/`
  (`briefing.dc.html` is the target; `design-chat.md` is where intent landed).
- Daily surface contract: [[wiki/specs/daily-surface]].
- HTTP surface (routes, auth, query-token trust boundary): [[wiki/specs/http-surface]].
- CLI density system (presenter, glyphs): [[superpowers/specs/2026-06-14-cli-output-density-v2-design]].
- Current code: `src/http/today-html.ts`, `src/cli/commands/today.ts`,
  `assets/extensions/dome.daily/processors/today.ts` + `action-state.ts`,
  `assets/extensions/dome.agent/processors/brief.ts` + `lib/brief-shared.ts`,
  `src/core/generated-block.ts`.
