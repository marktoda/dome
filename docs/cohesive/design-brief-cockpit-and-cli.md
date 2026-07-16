---
title: Design brief — Dome cockpit & CLI output
date: 2026-06-14
status: brief
audience: external designer
---

# Design brief — Dome cockpit & CLI output

> **Historical design brief.** The standalone `/today` cockpit described here
> was retired on 2026-07-16 in favor of the cohesive Dome Home PWA at `/`.
> `GET /tasks` remains the structured Today contract and `GET /today` only
> migrates old bookmarks.

## What we're asking for

We have two human-facing surfaces that show the same underlying information, and we
want one **coherent visual language across both**:

1. **The CLI** — text output in a terminal (a suite of commands).
2. **The cockpit** — a web page (`/today`) you open on a phone or second monitor.

The CLI recently went through two readability passes and has a settled design
system. The web cockpit is functional but visually plain and predates that work.
We'd like you to (a) pressure-test and extend the CLI design language, and
(b) give the web cockpit a real design — unified with the CLI so they feel like
one product.

You don't need to write code. Mockups + a point of view on hierarchy, type,
color, spacing, and the empty/idle states are what we're after. Annotated
redlines or a small style spec we can implement from is ideal.

---

## What Dome is (the 60-second version)

Dome is a **personal work compiler**. You keep your notes, tasks, and projects as
plain markdown files in a git repo (a "vault"). A local background process watches
your commits and continuously **compiles** that markdown into useful derived
state: a search index, your open tasks and follow-ups, a daily brief, and
questions it needs you to answer. You also work alongside an AI agent (Claude)
that reads and edits the same vault.

The mental model is a compiler, not an app:

- **You write markdown** (directly or by talking to the agent) and commit it.
- **Dome compiles it** in the background — extracting tasks, links, follow-ups,
  and surfacing things that need attention.
- **Everything is source-backed** — every task, answer, or brief item traces back
  to a specific line in a specific markdown file. Nothing is invented or floating.

Two important consequences for design:

- **It's calm and ambient, not transactional.** The user isn't filling forms or
  clicking through flows. They're writing, and Dome quietly keeps a live picture
  of "what's open" and "what needs you." The surfaces are mostly **read** — a
  glance, not a session.
- **The output has two audiences.** A human (at a terminal or on a phone) and AI
  agents (which consume a machine-readable `--json` form). **You're designing only
  the human surfaces** — the machine form is separate and untouched. This is why
  we can make the human view aggressively clean: anything a machine or a
  power-user needs in full detail lives behind `--json` or a `--verbose` flag.

The user today is a single power user dogfooding it (technical, lives in the
terminal, glances at the phone). Design for *that* person: someone who wants
signal at a glance and doesn't want to read a wall of text.

---

## Surface 1 — The CLI (terminal output)

A set of commands the user runs in a terminal. The most relevant for design:

- `dome status` — the vault's pulse: what needs attention right now.
- `dome check` / `dome doctor` — health: problems found, each with a fix.
- `dome today` — the daily brief in the terminal (same content as the web cockpit).
- `dome query` — search results.
- `dome lint`, `dome log`, `dome inspect` — supporting views.

### The design language already in place ("signal-first, calm")

We just rebuilt these to be low-density and scannable. The established system,
which we want you to validate and extend:

- **Verdict first.** Every command opens with a one-line headline: what you ran on
  the left, a status verdict on the right (`✓ healthy`, `⚠ 2 need attention`,
  `• 10 matches`). The user can read line one and stop.
- **Show only what matters.** Healthy / zero / empty things collapse to a single
  line (`✓ everything else clean`). The full breakdown is one `--verbose` away.
  Passing states are nearly silent — that quiet is the reward.
- **One glyph vocabulary, leading every line.** `✓` ok · `⚠` warning · `✗` error ·
  `•` info/neutral · `○` empty/off · `→` next action · `·` separator. A glyph
  leads each meaningful line so the eye scans the left edge. **Meaning never rides
  on color alone** (accessibility) — the glyph carries it too.
- **Color is signal, not decoration.** Green/yellow/red/cyan map to status; dim
  for secondary text; default foreground for everything else. Sparingly.
- **Calm spacing, no chrome.** 2-space inset, blank lines to group, lowercase
  prose labels. No boxes, no full-width rules, no ALLCAPS section headers in the
  default view.
- **Findings read like compiler errors** (think Rust/Elm): a severity-glyph +
  code + subject header, a one-line plain-language summary, and a `fix:` line. The
  long "why it matters" prose is deferred to `--verbose`.
- **One next action.** When there's something to do, a single `→ <command>` line
  sits near the top.

### Example (current `dome status`, attention state)

```
dome status · docs                    ⚠ 2 need attention

  → dome sync   adopt 45 pending · rebuild stale projection

  ⚠ sync         45 pending, synced 11h ago
  ⚠ projection   stale (cache drift)
  ✓ everything else clean

  --verbose for full vault + engine
```

All-clear is ~2 lines: `dome status · docs   ✓ healthy` + a one-line fingerprint.

### Terminal constraints (hard realities to design within)

- **Monospace, fixed-width.** Alignment is free; proportional type is not an
  option.
- **16-color ANSI palette**, not truecolor. Colors must read on both light and
  dark terminals and degrade gracefully. `NO_COLOR` and non-interactive (piped)
  output drop color entirely — the layout must still read in plain text.
- **Unicode glyphs have ASCII fallbacks** (`✓`→`√`, `⚠`→`!`, etc.) for terminals
  that can't render them.
- **No animation / no spinners** (they break screen readers; we use static text).
- The design lever here is **structure, whitespace, alignment, and the sparing,
  semantic use of color + glyphs** — not graphics.

Your job on this surface is lighter: confirm the system holds together, refine
the glyph/color choices and spacing rhythm, and make sure it feels like the same
product as the web cockpit. (We're open to revisiting the palette.)

---

## Surface 2 — The cockpit (web page)

`GET /today` — a self-contained HTML page the user opens in a browser on their
**phone or a second monitor** while they work. It auto-refreshes and shows the
live daily brief. This is the surface that most needs your eye.

### What the cockpit is *meant* to be

- **An ambient, glanceable "what's on my plate today" dashboard.** Not an app you
  operate — a screen you glance at. The user is working elsewhere (writing, in
  meetings); the cockpit is peripheral, like a status board.
- **Always current.** It refreshes as the vault changes (currently a dumb
  ~15-second page reload), so it reflects "now" without the user doing anything.
- **The morning brief + the running action surface.** First thing in the day it's
  the brief; through the day it's the live list of what's open and what Dome needs
  from you.
- **Read-mostly.** The user doesn't edit here. Capture happens elsewhere (a voice
  shortcut on the phone that posts a note into the vault). So the cockpit's job is
  *presentation and glanceability*, not interaction. (If you see a case for a
  light interaction — e.g. tapping a question — flag it, but assume read-only by
  default.)

### Content model (what appears on the page)

All of it comes from one compiled view (`dome.daily.today`), and every item is
source-backed:

- **A header**: the date + a count (`N open`, or "all clear").
- **Open tasks** — each with its text, an optional **due date**, and the **source
  location** (the markdown file/line it lives in).
- **Follow-ups** — same shape as tasks (things to circle back on).
- **Questions** — things Dome needs the user to answer: a short id (`#3`), the
  question text, and the command to resolve it.
- **The all-clear state** — when nothing is open. This is a *frequent and
  important* state (a calm "you're clear" screen), not an afterthought.

### Current state (what exists today — your starting point)

The page works but is deliberately minimal: a dark page (`#111` bg, `#eee` text),
`system-ui` font, ~42rem max width, `h2` section headings in a muted blue,
bulleted lists, monospace `<code>` for resolve commands, a muted "auto-refreshes
every Ns" footer. It's a single self-contained HTML file with inline CSS and **no
external assets** (no web fonts, no JS framework, no images). Roughly:

```
dome today   2026-06-14 · 3 open

Open tasks (2)
  • Draft the Q3 roadmap   due 2026-06-20   wiki/projects/roadmap.md:14
  • Reply to the vendor    inbox/raw/2026-06-13-vendor.md

Questions (1)
  #3  Should the calendar sync run hourly or daily?
      dome resolve 3 hourly

auto-refreshes every 15s
```

It reads fine but has had zero design attention — no real type scale, hierarchy,
spacing system, empty-state treatment, or mobile polish. That's the opportunity.

### Web constraints (looser than the terminal, but real)

- **Two form factors**: a phone (portrait, glance distance, possibly across a
  room) and a desktop second monitor. Legibility at a glance matters more than
  density.
- **Currently self-contained** (inline CSS, no external requests) and
  **dark-themed**. We're open to changing any of this — web fonts, a light/dark
  toggle, a small amount of JS, an SVG icon set — if it earns its keep. Just call
  out dependencies you'd introduce; "no external assets, fast, works offline on
  the LAN" is a value we'd like to keep unless there's a strong reason.
- **Auto-refresh** is a full page reload today; if your design depends on smoother
  updates, note it (we can move to live updates).
- It's served locally (loopback or LAN), token-gated — so no auth/login UI to
  design; assume the user is already authorized.

### One unifying principle we care about

The cockpit and the CLI show the **same brief**. They should feel like the **same
product in two media** — the same vocabulary of "open task / follow-up /
question," the same calm signal-first posture, the same restraint with color and
the same treatment of the all-clear state. The terminal's glyph language (`✓ ⚠ ✗
• ○ →`) is one expression of a status vocabulary; we'd love a web expression of
the same idea (icons, color, weight) so a user moving between the two never feels
they've changed apps.

---

## What we'd love from you

1. **A cohesive visual language** spanning both surfaces — a small style spec:
   the status vocabulary (how "ok / attention / problem / info / empty" reads in
   each medium), color usage, type (web), spacing rhythm, and how items
   (task/follow-up/question) are represented.
2. **The cockpit web UI, designed** — mockups for: the brief with content (tasks /
   follow-ups / questions), the **all-clear state**, phone + desktop layouts, and
   the refresh affordance. A point of view on hierarchy and glanceability.
3. **A light pass on the CLI** — validate/refine the existing signal-first system
   (glyphs, color, spacing) and make sure it harmonizes with the web cockpit.
4. **Edge/empty states explicitly** — all-clear, a single item, a long list, a
   stale/loading moment. These are where calm products win or lose.

## How to see it for yourself

- **CLI**: run `dome status`, `dome check`, `dome today`, `dome query <text>` in a
  terminal (and the same with `--verbose`) against a vault. The current visual
  system is what you'll see.
- **Cockpit (historical)**: this surface can no longer be launched. For the
  current browser product, start Dome Home and open its root PWA URL.

## Reference material (background, optional)

- CLI design system & rationale: `docs/superpowers/specs/2026-06-12-cli-output-readability-design.md`
  and `docs/superpowers/specs/2026-06-14-cli-output-density-v2-design.md`.
- Where the cockpit came from (it's "workstream 4" of the v1 plan):
  `docs/cohesive/brainstorms/2026-06-11-dome-v1-plan.md`.
- The retired web renderer was deleted with the `/today` cockpit. The terminal
  brief remains at `src/cli/commands/today.ts`; the browser implementation is
  the PWA.
