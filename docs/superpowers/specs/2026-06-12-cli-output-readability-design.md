---
title: CLI output readability revamp — diagnostic-first, signal-dense
date: 2026-06-12
status: design
topic: cli-output-redesign
sources:
  - "[[superpowers/specs/2026-06-03-cli-presenter-design]]"
  - "[[wiki/specs/cli]]"
---

# CLI output readability revamp — diagnostic-first, signal-dense

## Problem

The [[superpowers/specs/2026-06-03-cli-presenter-design|presenter layer]]
(2026-06-03) gave the CLI a clean rendering substrate: a `Caps`-driven pure
renderer (`src/cli/presenter/`), a tone vocabulary, glyphs with ASCII
fallback, width-awareness, and primitives (`headline`, `section`, `kv`,
`table`, `tree`, `nextActions`, `footer`). The *machinery* is good. The
remaining problem is **information architecture and density** — the output is
verb-dense and word-dense, and shows developer telemetry by default.

Dogfooding every command against the `docs/` vault surfaced four concrete
classes of problem:

1. **`query` / `export-context` leak debug telemetry.** Every match carries a
   `why:` line of raw ranking internals:
   `why: text match; 6 linked from matchess; matrix page; many graph signals; recency decay x0.98 (score 16.42, fts -6.70666735512889)`.
   Raw FTS scores, a `matchess` typo, and graph-signal counts are
   creator-only detail (clig.dev: "don't output information only
   understandable by the creators by default"). They bury the one thing a
   reader wants — *what matched and where*.

2. **`check` / `doctor` findings are run-on walls.** Each finding is a single
   long sentence fusing the *what*, the *consequence*, and the *fix*:
   `[warning] capability.grant-entry-missing: Processor dome.markdown.core-size declares 'read' over 'core.md' but the vault grant does not cover that entry; the core-memory size lint never fires (its effective read scope is empty).`
   followed by a `recovery:` line. This is exactly the case the
   Rust/Elm "one concern per line" diagnostic format solves.

3. **All-zero count strings drown the signal.** Lines like
   `loops 9 known · 1 quiet · 0 attention · 0 drift · 2 partial · 6 inactive`
   and doctor's
   `findings outbox 0 failed · 0 stuck · orphans 0 · runs 0 failed · quarantine 0 · projection 0 · git 0 · …`
   render every zero at full weight, so the eye can't find the non-zero terms.

4. **Inconsistent verdict headers.** `status` → `! needs attention`,
   `query` → `√ 10 matches`, `inspect` → `* 5 rows`, `cost` → `o no spend in 7d`.
   Different glyph conventions and grammar per command; no shared contract.

The tool is read by **both humans (at a TTY) and AI agents (parsing
`--json`)**. The 2026-06-03 design already established two surfaces; this
revamp pushes harder on the human surface knowing the machine surface is
`--json`.

## Chosen direction

Decided collaboratively during brainstorming (2026-06-12):

1. **Agents read `--json`.** Tighten the human TTY surface aggressively for
   readability. Developer telemetry (FTS scores, fact dumps, exact
   timestamps, full IDs, full consequence prose) lives in `--json`, not the
   default text. This matches the `gh`/clig.dev TTY-detection model and the
   existing `--json` contract on every command.
2. **Findings adopt the full Rust/Elm anatomy.** Severity+code+subject
   header, a plain-language one-line *what*, a dim `note` for *why it
   matters*, and a `fix` line for the actionable suggestion — each on its own
   line. (RFC 1644's "show, don't tell"; Elm's `Hint:`.)
3. **Keep layout stable; dim the zeros.** Do *not* hide or reorder
   count-string terms — predictable layout matters. Zero-valued terms render
   in the `muted` tone so the eye skips them while the structure stays fixed.
4. **Plan now, build next.** This doc → an implementation plan → review →
   build. No code this session.

These are deliberately mixed in aggressiveness: hard on telemetry and finding
structure, conservative on layout stability. The unifying principle is the
**inverted pyramid** — verdict first, then the single next action, then
detail — with **data-ink maximized** (erase non-data-ink; reserve color/bold
for signal).

## Design system

Everything below is additive to the existing presenter layer. No data-layer
or `--json`-schema changes; the surface collectors already produce the
structured data these renderers consume.

### 1. Glyph + tone vocabulary (codified contract)

The glyph set already exists (`theme.ts`); this revamp makes its *semantics* a
documented contract so new commands can't drift. Two contexts share the same
glyphs:

| glyph (unicode / ascii) | tone | verdict-header meaning | finding-severity meaning |
|---|---|---|---|
| `✓` / `√` | ok (green) | good · clean · pass · all-clear | — |
| `⚠` / `!` | warn (yellow) | needs attention · warnings present | warning |
| `✗` / `x` | err (red) | error · failure · blocked | error / block |
| `•` / `*` | info (cyan) / plain | neutral count result (N matches, N rows) | info |
| `○` / `o` | muted (dim) | empty · off · none (no rows, off, no spend) | — |

Rule: a command's verdict glyph is a pure function of its worst state. A
finding's glyph is a pure function of its severity. The `info`/`•` collision
between "neutral count" and "info-severity finding" is intentional and
harmless — both read as cyan/neutral, disambiguated by context.

### 2. Verdict header grammar

Every command's first line is:

```
dome <cmd> · <vault>                              <glyph> <verdict>
```

(The `headline` primitive already produces this; the `·` separator is the
unicode `sep` glyph.) The work is making the **verdict phrasing** uniform:

- A *state* verdict when the command reports health: `needs attention`,
  `ok`, `not available`.
- A *count* verdict when the command returns a result set:
  `N matches`, `N rows`, `no rows`, `no spend in 7d`.

The verdict is never a sentence and never carries a trailing clause.

### 3. The "Next" line — single action, above the fold

When a command implies an action, exactly **one** `→` line appears
immediately under the header, before any section (inverted pyramid: the thing
to do is above the fold). The suggested command is the **human** form — it
does *not* carry the `--json` suffix the surface layer appends for adapter
uniformity. (Today `status` prints `> dome sync --json` to a human; that
becomes `→ dome sync`.) When there is no action, the line is omitted.

### 4. The `Finding` primitive (new)

A shared renderer used by `check`, `doctor`, `lint`, and any future
diagnostic surface. Anatomy, mapped to the rustc/Elm structure:

```
  <sev-glyph> <code> · <subject>                 ← like  error[E0308]: title --> file
      <what — one plain-language line>           ← the message
      note   <why it matters — consequence>      ← like  note:
      fix    <actionable suggestion>             ← like  help:
```

Concrete:

```
  ⚠ capability.grant-entry-missing · dome.markdown.core-size
      core.md is declared 'read' but the vault grant doesn't cover it
      note   the core-size lint never fires — its read scope is empty
      fix    add "core.md" to extensions.dome.markdown.grant.read
```

Field mapping (honest about what exists today):
- Today a diagnostic carries `code`, `severity`, `message`, and a
  `recovery` string. The renderer maps **`message` → `what`** and
  **`recovery` → `fix`** with no parsing. The `subject` (processor/file) is
  already a separate field.
- The current `message` often *fuses* the consequence into the sentence
  (`… declares 'read' over 'core.md' but the grant does not cover that entry;
  the core-size lint never fires …`). The renderer does **not** try to split
  that sentence — brittle, and risks inventing structure. Instead, the `note`
  line is rendered **only when the diagnostic carries a distinct consequence
  field**. That field does not exist yet, so in the first cut `note` is
  usually absent and the `what` line shows the full message.
- Populating a distinct `consequence` on the diagnostics that processors emit
  (so `what` becomes the terse claim and `note` the "why it matters") is a
  **follow-up enrichment, out of scope for this revamp** — tracked as a
  separate task. The visual anatomy is built now so the data can grow into it
  without another rendering change.
- `note` and `fix` are dim labels in an aligned 4-char column; their content
  is plain tone. A `fix` line wraps with hanging indent under its content
  column, never under the label. `fix` is omitted when there is no `recovery`.
- The *full* original message is always preserved verbatim in `--json`; only
  the human rendering is restructured.
- Findings are ordered by severity (err → warn → info), stable within a
  severity.

### 5. The `Match` primitive (new)

Used by `query` (and, in trimmed-markdown form, `export-context`). Anatomy:

```
  <rank>  <title>                                <path, right-aligned>
     › <section breadcrumb>
     <snippet, wrapped, leading/trailing ellipsis preserved>
     <short-oid> · lines <a>–<b>
```

Concrete:

```
  1  Effect router targets                wiki/matrices/effect-router-targets.md
     › Phase compatibility precedes capability enforcement
     …the rejected effect is not applied, not recorded in its expected
      sink, not broker-checked, and not capability-checked…
     ba1de2b · lines 46–56
```

Rules:
- The `why:` ranking line and the `facts:` dump move **entirely** to `--json`.
  Rank order conveys relevance; raw scores are creator-only detail.
- A one-line result summary sits under the header:
  `"<query>" — showing N of M, raise with --limit` (the `has_more` affordance,
  made human).
- `export-context` is a special case: its markdown *is* an agent-facing
  deliverable, so it keeps its document structure, but the
  `Ranking: … (score …, fts …)` line becomes a qualitative
  `Relevance: text match · matrix page · highly linked` and the
  `… N more facts` dump is trimmed. Called out explicitly so the implementer
  doesn't strip structure the agent consumer needs.

### 6. Humanize rules (relative time, trailer strip)

- **Relative time everywhere in the human surface.** `status`'s `last sync`
  and `log`'s per-entry timestamps render via the existing
  `relativeTime` helper (`2h ago`); the exact ISO stays in `--json`.
  (`inspect` already does this.)
- **Strip commit trailers from `log` bodies.** `Co-Authored-By:` and other
  `Trailer: value` lines are dropped from the human body (still present in git
  and `--json`) — pure noise in a scannable activity view.

### 7. Dim-zero rule

In any `A · B · C` count-string, a term whose count is `0` renders in the
`muted` tone. Terms are never removed or reordered (layout stability). This
applies to `status` (runs/outbox/loops), `doctor` (the findings breakdown),
and `lint` (the issues breakdown).

## Per-command application

| command | change | risk |
|---|---|---|
| `status` | relative `last sync`; dim zeros; two-column "at a glance"; `→` next-action drops `--json`; tighter content line | low |
| `check` | engine row summarizes count; findings via `Finding` primitive | med |
| `doctor` | findings via `Finding` primitive; dim-zero the breakdown line | med |
| `query` | `Match` primitive; `why:`/`facts:` → `--json`; human "showing N of M" summary | med |
| `export-context` | qualitative `Relevance:`; trim facts dump; keep structure | low |
| `log` | relative time; strip commit trailers from body | low |
| `lint` | dim-zero issues line; conform header; issues (when present) via `Finding` | low |
| `inspect` | tables unchanged; conform verdict header (`• N rows` / `○ no rows`); the `… hidden → --json` footnote becomes a shared primitive | low |
| `today` / errors | bare error sentences gain verdict header + `Finding`-style `fix` line | low |

## What moves to `--json` (developer-only detail)

- query/export-context: raw FTS scores, `score`/`fts` numbers, graph-signal
  prose, full `facts` lists.
- findings: the full message is unchanged in `--json` (the human view simply
  restructures it into `what`/`fix` lines).
- status/log: exact ISO timestamps (relative shown in text).
- inspect: full IDs, exact `duration_ms`, full timestamps (already deferred).

No field is *removed* from `--json`; the human surface is a strict
readability projection of the same data.

## Architecture

Two new pure primitives in `src/cli/presenter/` — `finding(...)` and
`match(...)` — alongside the existing ones, each a pure function of its
structured input plus `Caps`. A small `humanizeCommand` helper strips the
`--json` suffix from a suggested command for the `→` line. The dim-zero
behavior is a formatting helper (`dimZeros(parts, caps)`) applied where
count-strings are built. Renderers in `src/cli/commands/*` and
`src/cli/maintenance-loop-summary.ts` are updated to call the new primitives;
the surface collectors (`src/surface/*`) are untouched.

## Testing

The presenter's design — pure functions with injected `Caps` — already
supports exact-output assertions. Each new primitive gets unit tests across
the `Caps` matrix (color/no-color, unicode/ascii, narrow/wide width). Per
clig.dev's TTY contract, tests assert that `NO_COLOR` and non-TTY produce
plain output and that `--json` output is byte-identical to today (no schema
drift). Golden-style tests for each command's human rendering against a
fixture snapshot catch regressions in the new layout.

## Non-goals

- No new output mode (`--plain` stays out, per the 2026-06-03 decision).
- No truecolor, no boxes/borders (Tufte: erase non-data-ink).
- No `--json` schema changes.
- No animated spinners (gh accessibility note: they break screen readers).
- No reordering or hiding of count-string terms (layout stability).

## References

- Predecessor: [[superpowers/specs/2026-06-03-cli-presenter-design]] — the
  presenter layer this extends.
- rustc diagnostic anatomy: RFC 1644 (default and expanded rustc errors),
  rustc-dev-guide Errors and lints. Severity + code + primary/secondary
  spans + `note:`/`help:` with applicability.
- Elm "Compiler Errors for Humans" / "Compilers as Assistants" — prose
  lead-in + code frame + `Hint:`; the named inspiration for RFC 1644.
- clig.dev (Command Line Interface Guidelines): humans-first output,
  progressive disclosure ("only in verbose mode"), signal-to-noise, suggest
  next commands, TTY-gated color, `--json`.
- Charm Lip Gloss / GitHub `gh` / Stripe: TTY-adaptive output, sparing
  color, errors that state the next action.
- NN/g + Tufte: inverted pyramid, F-pattern scanning, data-ink ratio /
  chartjunk, Gestalt proximity for grouping without drawn boxes.
