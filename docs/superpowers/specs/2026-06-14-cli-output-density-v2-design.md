---
title: CLI output density v2 — signal-first, calm
date: 2026-06-14
status: design
topic: cli-output-redesign
sources:
  - "[[superpowers/specs/2026-06-12-cli-output-readability-design]]"
  - "[[superpowers/specs/2026-06-03-cli-presenter-design]]"
  - "[[wiki/specs/cli]]"
---

# CLI output density v2 — signal-first, calm

## Problem

The v1 readability revamp
([[superpowers/specs/2026-06-12-cli-output-readability-design]], shipped
2026-06-12) gave the CLI a unified glyph/tone vocabulary, a Rust/Elm `finding`
primitive, a telemetry-free `match` primitive, relative times, and dimmed
zeros. The *findings* and *query* surfaces came out genuinely clean. But
looking at the real rendered output afterward, the **dashboard commands
(`status`/`check`/`doctor`) and the all-clear/empty states are still
text-dense** — they read like a config dump, not a designed surface. Concrete
evidence from running them against the `docs` vault:

- **`doctor`'s breakdown line is the worst thing in the CLI** — 19 `·`-joined
  terms, ~16 of them zero: `outbox 0 failed · 0 stuck · orphans 0 · runs 0
  failed · quarantine 0 · projection 1 · git 0 · …`. Dimming the zeros did not
  save it; the signal (`projection 1 · 2 entry · 1 starved`) drowns. This is a
  direct failure of v1's "show all · dim zeros · stable layout" decision.
- **`lint` passing takes 9 lines** (a `CHECKED` section, an all-zero `issues 0
  total · 0 block · …`, an `ISSUES: none`, a full-width `────` rule, and a
  redundant `√ pass` footer) to say what should be one line.
- **`status` renders 5 sections** for a "quick pulse," with redundancy
  (sync/projection appear twice), an empty `DIAGNOSTICS: none` section, and
  zero-heavy `·`-runs.
- **`check`'s `NEXT` is a run-on paragraph** and still leaks `dome sync --json`
  (v1 only humanized `status`), plus `4 finding(s)` with a literal `(s)`.
- **Monotony:** every command is ALLCAPS-header + uniform `kv` rows + dense
  `·`-joins + a heavy full-width `────` footer.

Root cause: v1 fixed the *primitives* but kept the **over-structured dashboard
shell** and the **render-every-section/zero-at-full-weight** posture. Research
into modern, low-density CLIs (Vite/Astro/Bun banners, the Charm/Lip Gloss
philosophy, `gh pr status`, the `doctor` family, `eza`/`bat`/`delta`) converges
on one thesis: **the screen is finite; default output should answer in one
screen — ideally one line — and passing/zero/empty things should be silent.**
Everything else lives behind `--verbose`/`--json`.

## Chosen direction

Decided collaboratively during brainstorming (2026-06-14):

1. **Verdict-first, signal-only default.** The default human view shows the
   one-line verdict (in the header), the single next action, and ONLY the items
   that need attention. Everything healthy collapses to a single
   `✓ everything else clean` rollup. The full vault/engine/loops/content
   breakdown moves to `--verbose`. This **supersedes v1's "show all · dim
   zeros · stable layout"** for the default view.
2. **Terse-essence findings.** A finding's default `what` is a one-line
   essence + the `fix`. The full consequence prose (the "why it matters") moves
   to `--verbose`/`--json`. To get a clean essence rather than a brittle
   sentence-chop, first-party `dome.*` diagnostics gain an authored `summary`
   field at the source.
3. **Hybrid "signal-first, calm" vibe.** A severity glyph **leads every
   meaningful line** (`✓ ⚠ ✗ • ○`) so meaning never rides on color alone (the
   accessibility-correct choice), combined with calm spacing, lowercase prose
   labels, a 2-space inset block, and minimal chrome (no ALLCAPS section
   headers, no full-width rules, no zero/empty rows).
4. **A `--verbose` human tier.** `--verbose`/`-v` restores the full human
   breakdown (today's v1 dashboard, all counts including zeros, full finding
   prose + `why`). `--json` stays the machine path, byte-identical.

The unifying principle is **subtraction**: cut zero-counts, cut all-clear rows,
cut the footer, cut the boxes; inset and align what survives; let blank lines
do the sectioning; relocate (don't delete) the detail.

## Design system (v2)

Builds on the v1 presenter layer (`src/cli/presenter/`); the glyph/tone
vocabulary and the `finding`/`match` primitives are reused and extended.

### 1. Verdict header, no footer
`dome <cmd> · <vault>` on the left; a right-aligned `<glyph> <verdict>` tag on
the right (`⚠ 2 need attention`, `✓ healthy`, `• 10 matches`, `○ no rows`). The
status is stated **once**, here. The full-width `────` rule and the redundant
footer status line are **removed from every command**.

### 2. Inset + breathing room
The body is inset 2 spaces from column 0 (the "matting" that reads as a
designed surface). One blank line under the header; blank lines separate
groups; no boxes, no rules. Indentation is 2 spaces per level, max ~2 levels.

### 3. One next-action line
`→ dome <cmd>   <terse imperative>`, the command humanized via
`humanizeCommand` (never shows `--json`), rendered only when there is an
action. Replaces the current `check` run-on paragraph and fixes its `--json`
leak.

### 4. Glyph leads every signal line
Each attention item renders as `<glyph> <label>   <detail>` — glyph first,
label lowercase in a small left-aligned column, detail plain. Severity is
carried by the glyph **and** its color, never color alone.

### 5. Only non-OK shown by default; healthy rolls up
No zero rows, no empty sections. The set of checks that are fine collapses to a
single `✓ everything else clean` (or, when literally everything is healthy, the
command is one verdict line + an optional one-line fingerprint). The complete
per-check breakdown — including zeros, using v1's dimmed-zero rendering — moves
to `--verbose`, which is its correct home (the caller explicitly asked).

### 6. Findings: terse essence + fix, prose on demand
`finding` renders `<sev-glyph> <code> · <subject>` / a one-line `what` essence /
`fix`. Under `--verbose` it adds a dim `why` line (the consequence) and the
full original message. The essence comes from an authored `summary` field on
first-party diagnostics (see "Diagnostic summary enrichment").

### 7. Verbosity is a resolved capability
A `verbose` flag is threaded into the renderers the same way `Caps` is — one
read at the top, pure functions downstream. `--verbose`/`-v` is added to
`status`, `check`, `doctor`, `lint`. `--json` is unaffected and unchanged.

### 8. Glyph/tone vocabulary (unchanged from v1, now leading)
`✓` ok/green, `⚠` warn/yellow, `✗` err/red, `•` info/neutral-count (cyan/plain),
`○` muted/empty-or-off. The only change is position: glyphs lead lines instead
of trailing values.

## Per-command application

### status
- **Attention:** verdict header (`⚠ N need attention`) → one `→` action →
  glyph-led rows for each attention item → `✓ everything else clean` → a dim
  `--verbose for full vault + engine` hint.
- **All-clear:** `dome status · docs   ✓ healthy` + a one-line fingerprint
  (`✓ synced just now · 104 pages · nothing pending`).
- **`--verbose`:** today's full VAULT / ENGINE / loops / content sections with
  the v1 dimmed-zero rendering.

### check / doctor
- Default: verdict header (`⚠ 3 problems · 1 note`) → `→` action (check only)
  → findings in the terse anatomy.
- **doctor's 19-term breakdown line collapses** to a `✓ outbox, runs,
  quarantine, git, storage all clean` rollup; the full breakdown → `--verbose`.
- All-clear: one verdict line (`✓ healthy`).
- `--verbose`: full finding prose + `why`, plus the complete check breakdown.

### lint
- Pass: one line — `dome lint · docs   ✓ pass — 215 files, no issues`.
- Issues: findings in the shared anatomy.
- The `CHECKED` section + `ISSUES: none` + footer are removed from the pass
  case (available via `--verbose`).

### query
- Inherits the inset + verdict header (`• N matches`). Otherwise unchanged from
  v1 (already clean).

### log
- Inherits inset + a `• N entries` verdict. Keeps v1's relative-time +
  trailer-strip. Light touch.

### inspect
- Tables stay (tabular data is the right shape). Verdict header conforms; the
  `…hidden → --json` footnote stays; column headers lowercased for calm casing.
- Empty/zero states collapse to one line:
  `dome inspect cost · docs   ○ no spend in 7d`,
  `dome inspect questions · docs   ○ no rows` (today these are ~6-line blocks).

### today
- Happy path (the daily surface) unchanged. The v1 not-available finding
  already fits the new shape.

## Diagnostic summary enrichment (touches processors)

This is the one part of v2 that reaches beyond `src/cli/` into the
diagnostic-emitting processors. To render a terse essence without brittle
sentence-splitting, first-party `dome.*` diagnostics gain an optional authored
`summary` (the one-line essence) alongside the existing full `message`:

- The capability broker findings (`capability.grant-*`), `dome.markdown.*`
  lint/health diagnostics, and `dome.health.*` operational findings get a short
  `summary` authored at their emission site.
- The `finding` renderer uses `summary` for the default `what` and `message`
  (the consequence) for the `--verbose` `why`. When a diagnostic has no
  `summary` yet, the renderer falls back to the full `message` as `what` (no
  invented text) — so the enrichment can land incrementally.
- `summary` is additive to the diagnostic shape; `--json` continues to carry
  both `summary` (new) and the full `message` (unchanged). This is a structured
  ADDITION to `--json`, not a change to existing fields — the one allowed `--json`
  delta in v2, and it must be additive only.

## Contracts

- **`--json` byte-identical for existing fields.** The only permitted change is
  the *addition* of a `summary` field on diagnostics (Diagnostic summary
  enrichment). No existing field is altered or removed. Tests assert this.
- **`--verbose` loses nothing.** Every fact removed from the default view is
  reachable via `--verbose` (human) or `--json` (machine).
- **TTY/NO_COLOR/width** honored exactly as v1 (the `Caps` contract is
  unchanged; `verbose` is threaded alongside it).

## Architecture

Additive to the v1 presenter layer:
- Extend the resolved-capability pattern with a `verbose` boolean (resolved
  once per command, threaded into renderers — not read ad hoc).
- A `verdictHeader` is the existing `headline` with verdict phrasing; a
  `signalLine` primitive renders `<glyph> <label>   <detail>`; a `rollup`
  helper renders the `✓ … all clean` line from the set of healthy checks.
- The `finding` primitive gains a `summary?`/`verbose` path (essence vs.
  full prose + `why`).
- Remove `footer`-rule usage from the command renderers.
- Add `--verbose`/`-v` Commander options to status/check/doctor/lint.
- Diagnostic `summary` authoring in the first-party bundles + the surface
  collectors that carry diagnostics.

## Testing

- Presenter primitives (`signalLine`, `rollup`, verbose `finding`) get
  unit tests across the `Caps` × `verbose` matrix (color/no-color,
  unicode/ascii, narrow/wide, verbose on/off).
- Per-command tests assert the default view shows only attention items + the
  rollup, and that `--verbose` restores the full breakdown.
- `--json` byte-identity is asserted (existing fields unchanged; `summary`
  present as an additive field).
- All-clear / empty states assert the one-line shape.

## Non-goals

- No new output mode beyond `--verbose` (no `--plain`).
- No truecolor, no boxes/borders, no animation.
- No change to existing `--json` fields (only the additive `summary`).
- No reflow of `inspect` tables (tabular is correct) beyond header casing +
  empty-state collapse.

## References

- Predecessors: [[superpowers/specs/2026-06-12-cli-output-readability-design]]
  (v1, the primitives this extends) and
  [[superpowers/specs/2026-06-03-cli-presenter-design]] (the presenter layer).
- Vite/Astro/Bun dev-server banners — summary-first, inset, one repeated
  marker, aligned labels, progressive disclosure.
- Charm / Lip Gloss — structure/style separation, padding + dim weight,
  horizontal joins for two-column layouts.
- `gh pr status` / React Native + Homebrew `doctor` — collapse OK to a phrase,
  detail in a separate command/flag; only `✗` rows carry remediation.
- clig.dev — humans-first, brevity on success, signal-to-noise, suppress
  developer detail to verbose, suggest next command, TTY-gated color.
- eza/bat/delta — color as a learnable category, alignment as the source of
  "clean."
