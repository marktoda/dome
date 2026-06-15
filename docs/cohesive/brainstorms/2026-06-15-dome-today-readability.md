---
type: brainstorm
tags:
  - design
  - cli
  - daily
  - cockpit
  - presenter
  - readability
  - second-brain
created: 2026-06-15
updated: 2026-06-15
status: approved-design
sources:
  - "[[wiki/specs/cli]]"
  - "[[wiki/specs/daily-surface]]"
  - "[[daily]]"
  - "[[wiki/specs/task-lifecycle]]"
  - "[[cohesive/brainstorms/2026-06-15-task-origin-links]]"
---

# Making `dome today` readable — Phase 1 (render) + Phase 2 (content)

Approved design, 2026-06-15. The problem: `dome today` on the work vault
(12 overdue · 239 open) is hard to read — dense, titles chopped mid-word, and
the source links it *does* carry are sliced into uselessness (`[thread](…`,
`archives/C0B81NJU…`). This is the cockpit surface from [[daily]]; it should be
the calmest screen in the system, not the busiest.

## Diagnosis (grounded in the code)

Three complaints, three distinct causes:

1. **Cut-off / mangled links — a truncation bug.** `formatTodayResult` renders
   each task by calling `truncate(t.text, taskWidth)` (`src/cli/commands/today.ts`
   ~line 396), a blind visible-width character chop (`src/cli/presenter/width.ts`
   ~line 20). Task bodies carry inline markdown links — ` · [thread](https://…slack…)` —
   and the today-view parser only runs `stripWikilinks` (`src/surface/today-view.ts`),
   which removes `[[…]]` but **not** `[label](url)`. So the long URL sits in the
   visible text and gets sliced mid-URL. The link is present; the renderer
   destroys it.

2. **"No links off to things" — partly a terminal-medium problem.** Even
   untruncated, a terminal prints `[thread](url)` as literal characters, not a
   clickable link. Real click-to-jump needs OSC 8 hyperlinks (iTerm2, WezTerm,
   kitty, Ghostty, VS Code's terminal), which render a short clickable affordance
   and hide the raw URL — fixing clickability *and* the width problem at once.

3. **Density — two sources.** (a) *Render-side:* a flat list of long,
   sentence-shaped titles, each chopped mid-word (`— w…`), no grouping. (b)
   *Content-side:* 239 open / 12 overdue, and the titles themselves are
   paragraph-length. The first is formatting; the second is what the daemon puts
   in the daily and how it phrases it.

The render-side causes (1, 2, 3a) are self-contained in the CLI presenter and
fixable without touching the meaning loop. The content-side causes (3b) are
deeper. **Decision: two phases, render first** (immediate relief), content
second (its own spec).

## Phase 1 — the `dome today` render fix (this spec)

All changes live in `src/cli/presenter/` and `src/cli/commands/today.ts` (plus a
small parse helper). No processor, projection, or daily-note-preparation change.

### 1.1 Clickable links via OSC 8

A new presenter primitive:

```ts
hyperlink(label: string, url: string, caps: Caps): string
```

When the terminal supports OSC 8, it emits
`\x1b]8;;<url>\x1b\\<label>\x1b]8;;\x1b\\`; otherwise it returns the plain
`label` (the caller appends the `↗` glyph either way). Support is detected from
the environment with an allowlist — `TERM_PROGRAM` ∈ {`iTerm.app`, `WezTerm`,
`ghostty`, `vscode`}, `TERM` containing `kitty`, or an explicit
`FORCE_HYPERLINK`/`DOME_HYPERLINKS` override — and gated on `caps` (no
hyperlinks when color/ANSI is disabled, e.g. piped output or `--json`). The
visible width of a hyperlinked label is the width of `label`, not the escape
sequence — so it must be excluded from width math (the escape carries no
columns).

### 1.2 Pull links out of the sentence

A pure helper extracts inline markdown links from a task's display text:

```ts
splitInlineLinks(text: string): { readonly text: string; readonly links: ReadonlyArray<{ label: string; url: string }> }
```

It finds `[label](url)` spans (standard markdown link grammar; ignores images
`![…]` and `[[wikilinks]]`, already stripped upstream), removes them (and any
now-dangling ` · ` / trailing separator) from `text`, and returns the cleaned
sentence plus the ordered links. The today renderer then renders the clean
sentence followed by each link as a trailing clickable `label↗`
(via `hyperlink`). A task with no inline links is unchanged.

### 1.3 Clause-aware shortening (no mid-word cuts)

A new presenter helper for one-line labels, used in place of the blind
`truncate` for task rows:

```ts
shortenLabel(text: string, width: number, unicode?: boolean): string
```

After links are pulled out (1.2), it shortens the clean sentence to fit
`width`: cut at the last **word** boundary that fits, and prefer a nearby
**clause** boundary (`:`, `—`, `(`) when one falls within a small lookback of
the limit, then append the ellipsis. So `…catalog — w…` becomes
`…token catalog …`, never a severed word. (The existing `truncate` stays for
other call sites; `shortenLabel` is the task-row-specific refinement.)

### 1.4 Grouping + honest counts

Replace the flat list in `formatTodayResult` with per-bucket sections:

```text
OVERDUE
  ✗ <label>            <age>  <link↗>
TODAY
  ⚠ <label>                   <link↗>
OPEN
  • <label>                   <link↗>
```

- A section header (`OVERDUE` / `TODAY` / `OPEN`) is rendered only when its
  bucket is non-empty; most-urgent bucket first. The glyph still carries the
  bucket within a section (consistent with the current signal-led design).
- **Overdue is prioritized**: it gets the larger share of the visible cap (it's
  the urgent 12), open the remainder. Each section that overflows shows an
  explicit per-bucket remainder, consolidated into one muted line:
  `… N more overdue · M more open · dome today --verbose`.
- The `→` hero line and the `? ask` line are unchanged. `--verbose` still
  uncaps and still appends the brief.
- `--json` output is unchanged (structure-only; no rendering concerns).

### Non-goals (Phase 1)

- No change to **how many** tasks exist (the 239) — that is Phase 2.
- No change to **task title phrasing** at authoring/ingest time — Phase 2.
- No consolidation or stale-overdue cleanup — Phase 2.
- No new processor, projection, capability, or daily-note-preparation change.

### Testing (Phase 1)

- `splitInlineLinks`: extracts one and multiple links; strips dangling
  separators; leaves link-free text untouched; ignores `![img]` and bare text
  with unbalanced brackets.
- `hyperlink`: emits the OSC 8 escape under a supporting `caps`/env; returns
  plain label under a non-supporting env and under `--json`/no-color; the
  visible width equals `label`'s width.
- `shortenLabel`: never cuts mid-word; prefers a clause boundary when near the
  limit; returns the input unchanged when it already fits; handles
  width ≤ ellipsis length.
- `formatTodayResult`: renders `OVERDUE/TODAY/OPEN` headers only for non-empty
  buckets; overdue-prioritized caps; the consolidated per-bucket overflow line;
  link affordance present on a task that had an inline link; the all-clear and
  hero paths are unchanged (existing snapshot/tests stay green).

## Phase 2 — content/daemon (deferred, separate spec)

Sketched here so the boundary is clear; **not** designed in detail yet.

- **Title brevity at the source:** the daemon/ingest/brief render task lines as
  short scannable labels rather than paragraph-length sentences (where the long
  prose belongs in the linked note, not the task line).
- **Consolidation pass:** merge related open loops (e.g. the several
  Cody/routing-retention items) into one tracked thread — a meaning-loop
  operation, not a render trick.
- **Stale-overdue cleanup:** surface long-overdue items for close/defer rather
  than letting 12 overdue accrete silently.

These touch the meaning loop (ingest/consolidate/brief processors, claims, the
sweep) and get their own brainstorm → spec → plan cycle after Phase 1 ships.
Relates to [[cohesive/brainstorms/2026-06-15-task-origin-links]] (Phase 2 of
that work adds Slack permalinks as inline links — which this render layer will
surface as clickable affordances, so the two compose).
