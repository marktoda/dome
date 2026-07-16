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
  (overdue / due-today / this-week / later / someday), the five urgency
  sections, `totalOpen`, and two bounded-payload semantics. `agedBacklog`
  partitions only `source: backlog` rows that are at least 30 days overdue;
  `omittedOpenCount` is the non-negative difference between declared open
  task/followup counts and the rows actually loaded into the payload. Aged
  rows remain open, overdue, source-backed rows; they are not discarded.
- **Paint** — the CLI briefing labels older backlog explicitly; the HTTP
  cockpit and PWA fold it separately from ordinary overdue work. Later rows
  are folded using the actual selected bucket length, while count-only
  omissions get a separate non-expandable label (because an adapter cannot
  reveal rows it never received). Same model, three presentations — and they
  can no longer disagree on which tasks are overdue or pretend an omitted row
  is locally expandable.

`parseTodayView` (the CLI/HTTP lenient enrich — strip wikilinks, count
fallbacks) sits between the contract and the view-model on the render path; it
stays total (never throws) for render resilience, while the schema is strict for
the producer + agent/MCP consumers.

**Compatible widening — `blockId` (Task 9, 2026-07):** each task row optionally
carries its stamped `^block-anchor` id (`TodayTaskRow.blockId` /
`taskRowWireSchema`), sourced from `DailyTaskItem.blockId` in
`assets/extensions/dome.daily/processors/action-state.ts`
(`openLoopAnchorFromStableId` recovers it from the task's
`dome.daily.open-loop:<...>` stableId — undefined for the transient body-hash
fallback, never a synthesized id). It is the identity `performSettle`
(`src/surface/settle.ts`) looks up by `^anchor` scan. The PWA Brief panel is
the first consumer: a row with `blockId` gets a live checkbox that dispatches
`POST /settle` with `disposition: "close"`; a row without one stays
decorative. Adding the field is a pure widening — the schema, the lenient
parser, and every existing consumer treat its absence as "not yet anchored",
not an error.

## The generic layer: the View Contract (built)

The generic surface-view layer now exists. Each first-party catalog entry
(`src/surface/view-catalog.ts`) is a **View Contract** —
`FirstPartyViewEntry<TPayload, TView>` carrying the zod `payload` schema (tier
1) and an optional `buildViewModel` (tier 2). `runCatalogView` /
`validateStructuredRun` are generic over `TPayload`: the version tag
(`schemaTag`) is a cheap handshake that fast-fails before the schema parse, and
a tag-match-but-malformed payload is a distinct `invalid-payload` problem.
`data: unknown` is dead at the seam.

All four catalog views carry contracts: `today` (`todayPayloadSchema`), `query`
(`queryPayloadSchema`), `lint` (`lintPayloadSchema`), and `export-context` (an
inline passthrough `{ markdown }`). The three hand-rolled `parse(unknown)`
coercers that predated this — `parseQueryResult`, `parseLintData`, and
`export-context`'s `markdownFromData` — are deleted; their validation is the
schema, their projection is zod's default key-stripping. This is the sqlite
row-codec move one layer up: N hand-rolled mappers collapse to one declared
contract per view.

Realized design notes (the shape the build settled into):

- **`status` was *not* the second instance.** The design-it-twice bar was met
  several times over by `query` / `lint` / `export-context` — each already
  carried a hand-rolled coercer. `status` / `check` stay **out**: they are
  typed collectors (`buildStatusSnapshot` / `buildCheckReport`) on a different
  path, not `data: unknown` catalog views.
- **Paint stays per-adapter (tier 3).** Render functions (`renderLintText`,
  `formatQueryResult`, the today CLI/HTTP painters) live with their adapter, not
  in `surface/`; only the contract (schema + type) and the view-model move to
  `surface/`. Moving a renderer down would invert the surface→cli layering.
- **`query` is schema-only.** Its producer (`related.ts`
  `questionItemFromProjection`) already emits `resolveCommand` /
  `automationPolicy`, so the old consumer-side derivation fallback was dead — no
  view-model needed.
- **Degrade is an explicit per-adapter choice.** `today` keeps
  degrade-don't-fail: the CLI verb, the HTTP `/tasks` route, and the MCP tasks
  tool each pass an explicit `payload: z.unknown()` override and
  enrich via the total `parseTodayView`, making the degrade choice visible at
  the call site. The strict `todayPayloadSchema` stays bound to the entry for
  consumers that want it (the MCP brief-source narrowing). `query` / `lint` /
  `export-context` hard-fail (`invalid-payload`) — a malformed payload there is
  a producer bug, surfaced loudly.
