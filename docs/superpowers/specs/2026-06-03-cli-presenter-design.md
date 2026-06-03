---
title: CLI presenter layer — polished-minimal human output
date: 2026-06-03
status: design
topic: cli-output-redesign
---

# CLI presenter layer — polished-minimal human output

## Problem

The Dome CLI's human output has already moved off raw markdown (recent
commits redesigned the layout and added semantic color via `picocolors`),
but it still reads like *structured text dumped to a terminal* rather than a
designed surface. Concretely, dogfooding every command against the `docs/`
vault surfaced:

1. **No status glyphs.** Status is carried by color alone (`needs attention`
   in yellow). Color-only is an accessibility problem (~8% of men have
   red-green CVD) and slower to scan — the eye has no anchor.
2. **Inconsistent headline.** `init` / `status` / `check` print `Dome status …`
   (capitalized); `sync` prints `dome sync …` (lowercase). Two house styles.
3. **Title-case section headers** (`At A Glance`, `Already Present`) read like
   prose; reference CLIs (gh, cargo, Stripe, Vercel) use ALLCAPS + dim so
   headers recede and *data* pops.
4. **`inspect` tables are the worst offender.** `inspect processors` emits
   ~600-char-wide rows because the generic `formatTable` dumps every column,
   including raw `grant_details` JSON blobs. It overflows terminal width and is
   unreadable. `inspect runs` shows `duration_ms: 15.885916999999992`, full ISO
   timestamps, and full run IDs — machine data shown raw to humans.
5. **`check --loops` is a dense wall** — repeated labels per loop
   (`0 attention diagnostic(s), 0 drift diagnostic(s), 0 noise…`), no
   compression.
6. **No width-awareness anywhere** — nothing reads `process.stdout.columns`,
   nothing truncates or wraps.

The tool is read by **both humans (at a terminal) and AI agents (parsing
stdout via `--json`)**. The redesign must serve both without compromising
either.

## Chosen direction

Decided collaboratively during brainstorming:

- **Aesthetic:** polished-minimal — the gh/cargo/Stripe house style. ALLCAPS-dim
  section headers, leading status glyphs, aligned key/value columns, dim for all
  secondary text, a single thin rule before a summary footer. No boxes, no
  truecolor.
- **Modes:** two surfaces — human (auto-degrading) and `--json`. No third
  `--plain` mode.
- **Scope:** a shared presenter layer — one structured result per command,
  rendered through shared primitives.

## Architecture — pure renderers behind a resolved capability flag

Every command already produces the structured result that `--json` serializes.
The presenter is a **pure function from that struct → styled lines.** No
renderer reads the environment directly; the only environment read happens once,
at the top, producing a capability flag that is threaded through.

```
src/cli/presenter/
  caps.ts        resolveCaps(stream) → { color, unicode, width }   ← the ONLY env read
  theme.ts       glyph + color vocabulary, resolved against caps
  primitives.ts  headline · section · kv · statusValue · rule · tree · table · footer
  humanize.ts    relativeTime · ms · count · shortOid (cell formatters)
```

`resolveCaps` collapses output-mode precedence into one place:

- `--json` short-circuits the presenter entirely (serialize + return).
- Otherwise `color = NO_COLOR ? false : (FORCE_COLOR || stdout.isTTY)`.
- `unicode` derived from locale + TTY (drives glyph vs ASCII fallback).
- `width = stdout.columns ?? 80` (80 is the canonical fallback when piped/CI).

Renderers receive `caps` and are deterministic: passing
`{ color: false, unicode: false, width: 80 }` yields byte-stable ASCII — exactly
what the repo's pinned output assertions need.

Per command, the shape becomes:

```ts
const result = computeStatus(...)      // unchanged structured result
if (opts.json) print(formatJson(result))
else print(renderStatus(result, caps)) // layout = which sections / columns
```

`renderStatus` owns *layout* (which sections, which columns); `primitives` own
*styling*. `human-output.ts` and `format.ts` fold into the presenter.

## Cohesive fix: tone travels with the data, not a regex

Today `human-output.ts` *guesses* status color by regex-matching free strings
(`isGoodStatus`, `isBadStatus`, `isWarningStatus` — ~30 patterns like
`value.startsWith("adopted ")`). That is fragile and will rot as status strings
change.

The presenter inverts it: a command emits a structured status
`{ tone: 'ok' | 'warn' | 'err' | 'info' | 'muted', label: string }` because the
command *knows* the semantics. `statusValue(tone, label)` maps tone → glyph +
color. The brittle string-matching block is deleted.

## Visual vocabulary

- **Headline:** `dome <cmd> · <vault>` on the left (`dome` dim, `<cmd>` bold);
  `<glyph> <status>` right-aligned to `caps.width`. Falls back to a two-space gap
  when width is unknown.
- **Section headers:** `ALLCAPS` + dim; body indented two spaces.
- **Glyphs:**
  - `✓` ok (green) · `✗` error (red) · `⚠` warning (yellow)
  - `○` off / inactive / pending (dim)
  - `→` next-action / pointer (cyan)
  - `·` inline separator (dim)
  - ASCII fallback via `figures`: `√ × ‼ o > ·`.
- **Color is never load-bearing** — the glyph carries status independently.
  16-color palette only, so the user's terminal theme defines the actual hues.
- **Bold** reserved for the command name and the single most important number.
- **One thin rule** (`─` repeated to width, dim) only before the summary footer.
  No boxes.
- **Footer:** one line, leading glyph, restating the outcome + the next command.

### Reference render — `dome status`

```
dome status · docs                              ⚠ needs attention

  NEXT
  → dome sync        adopt 32 pending commits, refresh projection

  AT A GLANCE
  sync         ⚠ needed       diagnostics  ✓ 0
  projection   ⚠ stale        questions    ✓ 0
  draft        ✓ clean        serve        ○ off

  VAULT
  path     ~/dev/dome/docs
  head     733ca9d   ·   adopted c4f928f   ·   32 pending
  content  89 pages · 976 links · 1 raw (23.5 KB)

  ENGINE
  runs   0 pending · 0 failed        loops  4 quiet · 1 inactive (5)
  ───────────────────────────────────────────────────────
  ⚠ 1 action needed → dome sync
```

## Substrate tables — curated columns, width-fit

A `Column<R>` spec per `inspect` subject declares the human-relevant columns:

```ts
type Cell = { text: string; tone?: Tone };
type Column<R> = {
  header: string;
  get: (row: R) => Cell;
  priority: number;          // dropped lowest-first when over width
  align?: 'left' | 'right';
};
```

Rules:

- **Heavy/JSON columns** (`grant_details`, `bundle_grants`, full capability
  arrays) are **omitted from human output, retained in `--json`**.
- Cells pass through `humanize`: ISO → `2m ago`, `15.885916…ms` → `16ms`,
  full oid → `733ca9d`.
- Natural widths computed via `string-width`. If a row exceeds `caps.width`,
  truncate the widest cells with `cli-truncate` (`…`); as a last resort, drop
  the lowest-priority columns.
- A dim footer always names what was hidden and how to retrieve it
  (`capabilities + grant detail hidden → --json, or --processor <id>`).

### Reference render — `dome inspect processors`

```
dome inspect processors · docs              8 rows

  PROCESSOR                 BUNDLE      PHASE     MODEL
  dome.daily.agenda-with    dome.daily  view      ○
  dome.daily.carry-forward  dome.daily  garden    ○
  dome.graph.links          dome.graph  adoption  ○

  capabilities + grant detail hidden
  → --json, or --processor <id> for one row's full detail
```

**Single-row results** (filtered via `--processor` / `--code` / `--subject-id`,
or a subject that yields one row) keep the same curated narrow table for v1
(decided default). A hybrid "auto-card" that expands grants inline for a single
row is explicitly deferred.

## Modes & I/O discipline

- Two surfaces: **human** and **`--json`**.
- The human surface **auto-degrades**: full glyphs / color / right-alignment on
  a TTY → plain ASCII, no color, no right-align when piped or `NO_COLOR` is set.
- **Data → stdout; progress / spinners → stderr**, so
  `dome sync --json > out.json` stays clean JSON while a human still sees
  progress.
- `--json` payloads and exit codes are **frozen** — stable machine contract.

## Per-command application

- `status` / `check` — two-column at-a-glance grid + glyphs + rule + footer.
- `sync` / `serve` — compiled / operational blocks; live phase line deferred
  (see below).
- `inspect` — curated tables (above).
- `lint` / `doctor` — glyph status + findings list, rule + footer.
- `query` — ranked matches with dim provenance.
- `init` — created / updated / skipped blocks restyled.
- `check --loops` — compact per-loop status (glyph + name + one-line state),
  suppressing the repeated zero-count labels.
- **`export-context` is out of scope** — it emits markdown by design (an agent
  context packet where markdown *is* the product).

## Dependencies

- Keep **`picocolors`** (fastest, 16-color, Bun-compatible, already honors
  `NO_COLOR` / `FORCE_COLOR` / `isTTY`).
- Add (all pure-ESM, Bun-compatible, **CLI-only — `src/cli`, not core**):
  - **`string-width`** — mandatory for any alignment/padding (counts ANSI as 0,
    CJK/emoji correctly).
  - **`cli-truncate`** — width-correct cell truncation with `…`.
  - **`wrap-ansi`** — paragraph/description wrapping that preserves ANSI.
  - **`figures`** — glyphs with automatic ASCII fallback.

⚠️ **Cohesive check before adding deps:** verify
`tests/integration/bundle-deps.test.ts` (the structural fence behind
`ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY`) does not fence *all* new dependencies out
of the core surface. These deps are CLI-only and not LLM/MCP, so they should not
trip the invariant — but the implementation plan must confirm this, not assume.

## Testing & migration

- Renderers tested as **pure functions** against a `caps` fixture — exact-string
  assertions for `{ unicode: true, color: false, width: 80 }` and
  `{ unicode: false, color: false, width: 80 }` (ASCII fallback), plus a
  narrow-width truncation case.
- Existing pinned assertions (`init`, `status`, others) updated in the same
  change — expected churn.
- `--json` shapes and exit codes frozen; no command added or removed.

## Deferred / out of scope (YAGNI)

- **`serve` / `sync` live spinner phase line** — deferred to a phase 2. Ship the
  static restyle first; spinners are the riskiest, smallest-payoff piece.
  When added: `ora` only when TTY; piped/agent runs keep discrete log lines.
- Hybrid single-row `inspect` auto-card.
- No TUI / full-screen `serve`.
- No boxes, no truecolor, no `--plain` third mode, no theming config.
- `export-context` markdown output unchanged.
- `--json` contract unchanged.
