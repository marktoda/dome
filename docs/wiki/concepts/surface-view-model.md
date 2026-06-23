---
type: concept
tags:
  - architecture
  - surfaces
created: 2026-06-22
---

# Surface view-model

A pattern for surface views that are read by more than one protocol adapter
(CLI, HTTP, MCP, future shells). It keeps the *semantic* decisions in one place
and leaves adapters as thin painters — so two surfaces can't drift on what a
view "means", only on how they render it.

A surface view is three tiers:

1. **Payload contract** — the `/vN` schema is a *real declared shape*, not a
   string tag. One zod schema (`xxxPayloadSchema`) with an inferred
   `XxxPayload` type. The producing processor imports the **erased type** and
   constructs its `ViewEffect` data to it (compile-checked, zero runtime zod
   dependency in the bundle); every consumer **validates received payloads
   against the same schema** at the deserialization boundary. The schema pins
   the *consumed subset* and strips the producer's extra envelope fields (zod's
   default), so the contract stays small without rejecting extras.
2. **View-model** — consumer-derived presentation semantics: the decisions
   adapters would otherwise each recompute (classification, dedup, grouping,
   headline counts). A pure `buildXxxViewModel(payload)` returning a typed
   model. Optional — a view with no derived semantics stops at tier 1.
3. **Paint** — each protocol adapter renders the view-model and nothing more.
   It chooses *presentation* (glyphs vs. spans, sections vs. a summary chip) but
   never re-derives *meaning*.

## Why

A `/vN` string with no validator is the failure mode this retires: the producer
and every consumer keep a private copy of the shape, they drift, and the drift
shows up as defensive parsing and battle-scar comments
(`// sourceRefs is a PLURAL ARRAY`). One schema + a consumer view-model makes
the shape and the semantics single-sourced; adapters get leverage (paint a typed
model) and the surface gets locality (meaning changes in one place).

## Exemplar: `dome.daily.today/v1`

The worked instance ([[wiki/specs/daily-surface]]; `src/surface/today-view.ts`):

- **Contract** — `todayPayloadSchema` / `TodayPayload`. The producer
  (`assets/extensions/dome.daily/processors/today.ts`) emits `satisfies
  TodayPayload`; the agent tools and the MCP brief validate against the schema.
- **View-model** — `buildTodayViewModel`: per-task `TaskUrgency`
  (overdue / due-today / this-week / later / someday), hero-dedup, the five
  urgency sections, `totalOpen`.
- **Paint** — the CLI briefing renders all five sections; the HTTP cockpit
  renders overdue/today/this-week and folds the rest into a "+N more, later"
  chip. Same model, two presentations — and they can no longer disagree on
  which tasks are overdue.

`parseTodayView` (the CLI/HTTP lenient enrich — strip wikilinks, count
fallbacks) sits between the contract and the view-model on the render path; it
stays total (never throws) for render resilience, while the schema is strict for
the producer + agent/MCP consumers.

## Next instance

**`status` is the second instance to build** (`src/surface/status.ts` —
`buildStatusSnapshot` already exists; the CLI renders it richly, HTTP returns it
raw). Giving it a `dome.status/v1` contract + a status view-model is the natural
follow-on.

A **generic** surface-view layer (one abstract model every view produces and
every adapter renders, with schema validation wired into the view-catalog) is
deliberately deferred: design it against two concrete instances (today +
status), not one — see [[philosophy]] on generalizing only when the general form
is demonstrably cleaner, not guessed from a single example.
