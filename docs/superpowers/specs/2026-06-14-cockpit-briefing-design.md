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
and neither shows the richer "morning brief" the user wants (a warm narrative
framing of the day, calendar, reminders). The user mocked up a redesign with
Claude Design and chose **Direction B — "Briefing"** (bundle preserved at
`docs/cohesive/design-assets/cockpit-briefing/`): a warm 2–3 sentence narrative
at the top, then structure (calendar, questions, open tasks, reminders), in a
calm dark visual system, with a matching terminal.

Three design questions were raised and resolved during brainstorming:

1. **Reuse the daily note's brief, don't re-run an LLM per refresh.** Confirmed
   and adopted. `dome.agent.brief` already composes the daily note every morning;
   we add one forward-looking narrative block to it and the cockpit reads that.
2. **`dome decide` is unnecessary — drop it.** It only existed as the terminal
   mock's invented next-action. The "decision" is a task in the note, not an
   engine question; there is no verb to "do" a task. The real decision command is
   `dome resolve` (answering engine questions), which exists.
3. **Interactivity through the existing HTTP mutation surface.** `POST /resolve`
   and `POST /capture` already exist, so the cockpit can answer questions and
   capture notes directly — loosely coupled to the foreground agent *through the
   vault*, which is the correct Dome model.

## Chosen direction (decided 2026-06-14)

- **Briefing layout (Direction B)**, one responsive web page (phone + desktop)
  + a matching terminal `dome today`.
- **Brief sourced from the daily note** via a new `dome.agent.brief` narrative
  block — no per-refresh model call.
- **No `dome decide`.** The hero next-action is the most-urgent item itself
  (task highlighted, or `dome resolve` when it's a question).
- **Interactive: answerable + capture.** Tap a question option →
  `POST /resolve`; a capture box → `POST /capture`; tap-to-reveal the
  `dome resolve` command as fallback.
- **"Keeping in mind" derived** from existing signals (a free-text daily-note
  section + far-future high-priority tasks) — no new reminders engine.
- **System fonts**, faithful colors/layout/spacing (no licensed-font embedding).
- **Self-contained page** (no external assets), dark only, ~15s meta-refresh +
  action-driven fetch (no live-push this pass).

## Architecture

### 1. The today view becomes the single source (both surfaces render it)

Extend the `dome.daily.today/v1` document
(`assets/extensions/dome.daily/processors/today.ts`) with four additive fields.
All are sourced from the daily note / existing data — **no model call at view
time**. Existing fields (`openTasks`, `followups`, `questions`, `counts`,
`dueCounts`, etc.) are unchanged.

```
brief:        { text: string; sourceRef: SourceRef } | null
calendar:     { events: ReadonlyArray<{ time: string; title: string; meta: string | null }>;
                sourceRef: SourceRef } | null
keepingInMind: ReadonlyArray<{ text: string; source: "note" | "task"; sourceRef?: SourceRef }>
hero:         { kind: "task"; item: DailyTaskItem }
            | { kind: "question"; item: DailyQuestionItem }
            | null
```

- **`brief`** — read the new `dome.agent.brief:today` block (see §2) from the
  adopted daily note; strip `[[wikilink]]` markup to plain prose for display;
  `sourceRef` points at the daily note's brief block. `null` when the block is
  absent (model unavailable / pre-compose).
- **`calendar`** — parse `sources/calendar/<date>.md` **directly** with the same
  defensive parser the brief uses (`assets/extensions/dome.agent/lib/brief-shared.ts`
  — reuse it; do not re-parse the model-written meetings block). Cap at 20
  events. `null` when the file is absent (subscription off).
- **`keepingInMind`** — lines from an optional `## Keeping in mind` section in
  the daily note (`source: "note"`), then topped up with far-future
  high-priority open tasks not already shown elsewhere (`source: "task"`),
  bounded to a small N. Empty array when none.
- **`hero`** — the single most-urgent item: the most-overdue open task (by
  dueDate, then priority); if no overdue task, the top `owner-needed` unresolved
  question; else the soonest-due / highest-priority task; else `null`. Computed
  in the view so web and terminal agree.

Questions surfaced in "Dome needs you" remain the unresolved set, ordered
`owner-needed` first (agent/model-safe questions are auto-resolved upstream).

### 2. New `dome.agent.brief:today` narrative block

Add one model-written block to `dome.agent.brief`
(`assets/extensions/dome.agent/processors/brief.ts` +
`assets/extensions/dome.agent/lib/brief-shared.ts`):

- **Block marker** `dome.agent.brief:today`, spliced at the **top** of
  `## Start Here` (above the yesterday block) at the 05:30 compose and on
  late-source wake-ticks — the same composition pass that writes the existing
  blocks.
- **Content**: a warm, forward-looking 2–3 sentence framing of *today* — "here's
  your day" voice — grounded (every claim carries a `[[wikilink]]` source ref,
  enforced by the existing grounding pass; ungrounded sentences are stripped/
  re-emitted as questions, same as today).
- **Degradation**: model unavailable → block omitted (no fallback prose); the
  cockpit's `brief` field is then `null` and the page drops the hero paragraph.
- This is additive to the daily-surface block inventory; the
  `daily-surface` spec gains a row for it.

### 3. Web cockpit — rewrite `src/http/today-html.ts` to the Briefing design

One **responsive** page (the mock's phone + second-monitor are the same document
at different widths via CSS — no device frames in the real page).

**Visual tokens** (from the design; system fonts):
- Background `#0b0b0c` with a subtle radial dot-grid (`rgba(255,255,255,0.05) 1px`
  / 24px); surfaces `#131313`; cards `#1A1A1A` / inset `#0d0d0d`.
- Fonts: sans `-apple-system, system-ui, sans-serif`; mono
  `ui-monospace, "SF Mono", Menlo, monospace`. Body weight ~485.
- Status colors: ok `#21C95E`, warn `#FFBF17`, error/overdue `#FF593C`,
  question `#3ADCFF`; muted whites for `•`/`○` and secondary text.
- Accent pink `#FF37C7` — **whisper only**: the brand dot and the single
  next-action pill border/arrow. Nowhere else.
- Generous radii (15–24px on cards, pill borders), soft shadows, a slow
  `domePulse` on the "live" dot.

**Structure** (single column on phone; widens on desktop):
- Header: `<date>` (mono dim) + "Good morning." (large) + live pulse
  "updated Ns ago · live".
- **Brief** paragraph + provenance line (`↳ <daily path> · brief`). Omitted when
  `brief` is null.
- **Next-action pill** (the `hero`): pink-bordered, `→` + item text + urgency
  (e.g. `overdue 4d`). Omitted when `hero` is null.
- **On your calendar**: time | title | meta timeline. Omitted when `calendar` is
  null/empty.
- **Dome needs you**: questions, interactive (see §4). Omitted when none.
- **Still open**: glyph-led task list (`✗` overdue / `⚠` today / `•` open),
  source path revealed on hover/tap. Omitted when none.
- **Keeping in mind**: `○` + dim lines. Omitted when empty.
- Footer: live pulse + "updated Ns ago".

Desktop (≥ ~900px): brief hero full-width, then a two-column band
(calendar | needs-you + keeping-in-mind), then "Still open" in two columns.

**Edge states** (rendered from data):
- **All-clear** (nothing open, no questions): centered "You're clear." + a calm
  line + `✓ vault healthy`. No pink. The frequent, welcome state.
- **Single item**: the one item as the whole screen.
- **Long list**: group by urgency (overdue / today / this week) and collapse the
  far future to a "+N more, later" chip. Never a wall.
- **Stale / reconnecting** (a fetch failed): content dims and holds last-known; a
  yellow "reconnecting… last updated Nm ago" line owns the top.

### 4. Interactivity (small JS; token from `?token=`, sent as Bearer header)

- **Answer a question**: render the question's `options` as buttons; tap →
  `fetch("/resolve", { method:"POST", headers:{Authorization:"Bearer "+token},
  body: JSON.stringify({ id, value }) })`. On success: optimistic removal +
  brief toast; on failure: surface the error, fall to the reveal-command.
- **Reveal command (fallback)**: a "show command" affordance reveals
  `dome resolve <id> <value>` (the existing `resolveCommand`) to copy.
- **Capture**: a "+ capture a thought" control opens a small textarea → `POST
  /capture { text }` → confirmation. (Seed of the future voice flow.)
- **Refresh**: keep `<meta http-equiv="refresh">` ~15s for passive updates;
  actions fetch immediately so they don't wait for a reload.
- **Token**: read once from `location.search`'s `token` param. POSTs send it as
  an `Authorization: Bearer` header (fetch can set headers; the query-token
  escape hatch remains GET /today only — unchanged).

No new HTTP routes; `POST /resolve` and `POST /capture` exist as-is.

### 5. Terminal — restyle `dome today` to match

Reuse the v2 presenter (`src/cli/presenter/` — verdict header, `signalLine`,
glyph vocabulary) so it's consistent with the shipped CLI. Default is compact:

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

- Verdict header (`✗ N overdue · M open` / `✓ all clear`).
- One `→` hero line (the `hero` — task text or `dome resolve` for a question);
  **never `dome decide`**.
- A one-line calendar summary; glyph-grouped tasks (overdue/today/open); a
  single `? ask` line with the resolve command.
- The **full brief prose + source paths move to `--verbose`** (fits the v2
  density model — default stays compact).
- All-clear variant: verdict + a calm two-line state.

## Scope & non-goals

**In:** today-view fields (§1), the `dome.agent.brief:today` block (§2), the web
redesign + interactivity (§3–4), the terminal restyle (§5), edge states, tests,
and spec sync (`daily-surface`, `http-surface`, `cli`).

**Deferred / non-goals:**
- A real **reminders engine** (snooze/recurrence/projection) — we derive instead.
- **Voice input UI** — the capture box is the seed, not a voice feature.
- **Live-push updates** — keep ~15s meta-refresh + action-driven fetch.
- **Embedding licensed fonts** — system fonts only.
- No new `--json` *consumers* break: the today `--json` document only **gains**
  the four additive fields; existing fields are unchanged.

## Degradation rules

- No calendar subscription / file → `calendar` null → section omitted.
- No brief block yet (pre-05:30, or model off) → `brief` null → hero paragraph
  omitted; structure still renders.
- Empty vault / nothing open → the all-clear state.
- A failed action/refresh → the stale/reconnecting state; last-known stays
  readable.
- Page stays self-contained (no external assets) in every state.

## Testing

- **Today view**: unit tests for each new field — brief block read + wikilink
  strip; calendar parse (incl. malformed/absent → null); keepingInMind
  derivation (note section + far-future fill); hero selection precedence
  (overdue task > owner-needed question > soonest). `--json` additive-only
  (existing fields byte-stable).
- **Brief block**: the `dome.agent.brief:today` block composes/degrades; grounded
  bullets enforced; wake-tick re-compose unaffected.
- **Web renderer** (`today-html.ts`): pure-function tests over the document →
  HTML for each state (full, all-clear, single, long-list grouping, stale),
  asserting the sections, tokens, and that content is HTML-escaped; the
  interactivity JS is present and reads the token.
- **Terminal**: `dome today` default vs `--verbose`; verdict counts; hero line;
  no `dome decide`; matches the v2 presenter shape.
- **Interactivity**: POST /resolve + POST /capture already covered by HTTP server
  tests; add a test that the rendered page posts to them with the bearer header.

## References

- Design bundle (preserved): `docs/cohesive/design-assets/cockpit-briefing/`
  (`briefing.dc.html` is the target; `design-chat.md` is where the intent landed).
- Daily surface contract: [[wiki/specs/daily-surface]].
- HTTP surface (routes, auth, query-token): [[wiki/specs/http-surface]].
- CLI density system (presenter, glyphs): [[superpowers/specs/2026-06-14-cli-output-density-v2-design]].
- Current renderers: `src/http/today-html.ts`, `src/cli/commands/today.ts`,
  `assets/extensions/dome.daily/processors/today.ts`,
  `assets/extensions/dome.agent/processors/brief.ts`.
