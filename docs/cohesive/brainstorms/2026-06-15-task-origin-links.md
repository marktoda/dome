---
type: brainstorm
tags:
  - design
  - capture
  - daily
  - tasks
  - provenance
  - sources
  - second-brain
created: 2026-06-15
updated: 2026-06-15
status: approved-design
sources:
  - "[[wiki/specs/capture]]"
  - "[[wiki/specs/task-lifecycle]]"
  - "[[wiki/specs/daily-surface]]"
  - "[[wiki/specs/effects]]"
  - "[[wiki/specs/sources]]"
  - "[[wiki/specs/vault-layout]]"
  - "[[wiki/specs/autonomous-agents]]"
---

# Inline task-origin links — context-on-the-line for captured TODOs

Approved design, 2026-06-15. The problem in one sentence: when a TODO shows up
in the daily note, there is no way back to where it came from — the Slack
thread to reply in, or the raw capture that explains the thought. This design
puts a small clickable origin link **on the task line itself**, so context is
one click away and travels with the task forever.

## The gap

Dome already has a provenance primitive — `SourceRef` (`{ commit, path,
range, stableId }`, [[wiki/specs/effects]] §"The SourceRef type") — but it is
**vault-internal by construction**: it can point at evidence inside an adopted
commit, and it has **no field for an external URL** (a Slack permalink, an
email, a web link). It is also an *effect-layer* object, not something that
renders on a task line a human reads in Obsidian.

Meanwhile the task-creation seam discards origin at the moment of lift:

- **Captures.** `dome.agent.ingest` reads `inbox/raw/<file>.md`, lifts tactical
  tasks into today's daily under `## Captured today`, and **archives the raw
  file to `inbox/processed/` in the same run**. The task line keeps no backlink
  — and any link the model *might* write to `inbox/raw/...` dangles the instant
  the archive lands.
- **Slack.** The `slack-day` digest ([[wiki/specs/vault-layout]]
  §"`sources/slack/YYYY-MM-DD.md`") is one line per message —
  `[#chan] HH:MM author: "text"` — with **no permalink**. So a Slack-derived
  task has nothing to link back to; the permalink was never in the file.

So the gap is concrete and asymmetric: captures *have* a link target (a vault
path) the seam can attach deterministically today; Slack has *no* link target
until the digest grammar carries one.

## Decision of record

**Approach A** (of three considered; B = model-authored links for both now,
rejected as fragile and still Slack-blocked; C = captures-only, rejected
because Slack is a named top origin):

> Ship deterministic capture backlinks first (Phase 1). Land Slack permalinks
> as a clearly-scoped, fully-specified Phase 2 — designed now so it is
> shovel-ready and additive, not a surprise.

Two origin classes, **Slack** (external permalink) and **own captures**
(vault file), share one task-grammar slot. The surface is **inline on the
task line** — plain markdown, clickable in Obsidian, no sidecar projection.

## The grammar — the task-origin marker

A captured task line gains an optional origin marker: a plain-markdown link
placed **after the description, before the block anchor**.

```markdown
- [ ] #task reply to Jane re: pricing ([↗](inbox/processed/2026-06-14-jane.md)) ^a1b2
```

Rules:

- **Plain markdown.** Obsidian renders `↗` as a clickable link; Dome treats the
  marker as ordinary task text. Nothing new to parse for identity.
- **Before the anchor.** The marker sits before `^id`, so
  `dome.daily.stamp-block-id` and `dome.daily.normalize-task-syntax` keep
  working unchanged — the anchor stays the trailing token
  ([[wiki/specs/task-lifecycle]]: "a block anchor is a *trailing* `^id`
  token"). Ordering is natural: the seam appends the marker at ingest; the
  stamp processor adds `^id` on the next cycle.
- **Style.** ` ([↗](target))` — parens + arrow glyph. Confirmed.
- **One marker per line.** The `↗` glyph is the visual tell. The target is a
  vault-relative path (Phase 1) or an external URL (Phase 2) — the grammar is
  identical, so Phase 2 adds no new shape.

## Phase 1 — deterministic capture backlinks (ships first)

The **captured-tasks seam** (`capturedAwareAppendTool`, in
`assets/extensions/dome.agent/lib/ingest-tools.ts`) becomes the **sole writer**
of the marker — never the model.

Mechanism:

1. Ingest's source loop (`for (const sourcePath of rawPaths)` in
   `processors/ingest.ts`) already processes one raw file per iteration. Before
   each iteration it sets the source's **archived** path —
   `inbox/processed/<name>`, computed deterministically by the same rewrite
   `archiveSource` uses (`rawPath.replace(/^inbox\/raw\//, "inbox/processed/")`,
   `lib/vault-tools.ts`) — onto the `CapturedTasksRouting` struct.
2. When the seam splices task lines for that source's appends, it appends
   ` ([↗](<archived-path>))` to each spliced line that does not already carry a
   marker.

Why the seam, not the model:

- The model is told (and length-capped) to keep task lines terse — "details
  belong in a linked note, not the task line."
- The model only knows the pre-archive `inbox/raw/...` path, which **dangles**
  the instant ingest archives the file in the same patch.
- A deterministic injection cannot fumble the URL or attribute the wrong
  source (one source per loop iteration → unambiguous attribution).

Details:

- **Cap accounting.** `CAPTURED_LINE_MAX_CHARS` measures the *model-authored*
  text only; the seam-added marker is overhead, excluded from the cap.
  Otherwise a long-but-legal task could push the marker past the limit.
- **Idempotency / rebuild.** The marker is written into committed markdown — it
  becomes ordinary source-of-truth task text, not a projection, so it survives
  `dome rebuild` for free ([[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]]). The
  seam skips lines that already carry a marker, so a re-splice never
  double-appends.
- **Degradation.** If the model never calls `archiveSource` (the existing
  `dome.agent.source-unarchived` diagnostic path), the link points where the
  file *would* be. That is already a flagged error; the marker is not the new
  failure and needs no extra handling.
- **Attribution edge.** Within one source-loop iteration only the current
  source is in the model's context, so every task spliced in that iteration is
  correctly attributed to the current archived path even across multiple
  `appendToPage` calls.

## Phase 2 — Slack permalinks (deferred, but de-risked here)

Phase 2 is **strictly additive** to Phase 1: the marker grammar, the seam, and
the placement rule are unchanged. Only the *source* of the link target differs
(an external URL instead of a vault path), and the link must be carried from
the digest because — unlike a capture path — only the model knows which digest
line a lifted task came from.

Three changes, scoped now so there are no surprises:

1. **Permalink source (the de-risk).** Slack message permalinks are obtainable
   from the same surfaces the foreground fetch already uses — the Slack Web API
   `chat.getPermalink` and the connector/MCP read tools (`slack_read_thread`,
   `slack_search_*`) all return a `permalink`. So the link *exists upstream*;
   nothing about Phase 2 depends on data Slack won't give us. The only work is
   threading it into the digest and onto the line.

2. **`slack-day` grammar extension** ([[wiki/specs/vault-layout]]
   §"`sources/slack/YYYY-MM-DD.md`"). Each entry gains an **optional trailing
   permalink**:

   ```markdown
   ## Mentions

   - [#dome-dev] 22:41 alice: "look at the outbox retry PR?" <https://uniswap.slack.com/archives/C…/p…>
   ```

   Backward-compatible by construction: the permalink is optional, the existing
   defensive parser ignores trailing tokens it does not recognize, and a digest
   without permalinks behaves exactly as today. `dome.agent.brief`'s parser
   (caps at 15 entries / 240 chars) is unaffected — it already tolerates extra
   trailing content.

3. **Fetch template** (`assets/source-handlers/claude-slack.sh`). The prompt
   gains one instruction: emit each message's permalink in the
   `<…>` autolink position. Template-only change; the consent surface (review
   the script, flip `enabled`) is unchanged.

4. **Attachment path.** The ingest charter gains a narrow instruction: when a
   task is lifted from a `sources/slack/<date>.md` entry that carries a
   permalink, pass that permalink to the seam as the task's origin. The seam
   formats and appends it with the **same marker grammar**. This is the one
   model-supplied-link path, accepted because there is no deterministic
   alternative for Slack (the model alone knows the task↔message mapping).
   Guardrails: the seam accepts only an `https://…slack.com/…` shaped target
   for the external case; anything else is dropped (no marker) rather than
   trusted.

**Forward-compat guarantee Phase 1 must honor** (so Phase 2 stays additive):

- The seam's marker-append must accept an *externally supplied target* as well
  as the computed archived path — Phase 1 wires only the archived-path caller,
  but the function signature takes a target string from day one.
- The "skip if a marker already exists" check keys on the `↗` marker shape, not
  on the target being a vault path.

## Non-goals (YAGNI)

- **Entity `## Open threads`.** Phase 1 targets only the `## Captured today`
  daily seam — the "random TODO in my daily" this design is for. Open-threads
  backlinks can follow with no new grammar.
- **No retroactive enrichment** of existing context-less TODOs. Forward-looking
  only.
- **No meeting / calendar / Granola / web-URL origins.** Ranked lower by the
  owner; the grammar already supports them later with zero new design — a future
  source just supplies a target to the same seam.

## Testing

Phase 1:

- **Seam unit.** Capture → spliced task line carries ` ([↗](inbox/processed/…))`
  immediately before any `^id`; link target equals the deterministic archived
  path; marker is excluded from the char cap; a second splice of the same line
  does not double-append (idempotent).
- **Integration.** Ingest a raw capture → adopted daily under `## Captured
  today` has the clickable backlink → `dome rebuild` preserves it byte-for-byte.
- **Anchor interaction.** `stamp-block-id` then appends `^id` after the marker;
  `normalize-task-syntax` preserves both.

Phase 2 (deferred with Phase 2):

- `slack-day` parser tolerates entries with and without the trailing permalink.
- A Slack-derived task carries an `https://…slack.com/…` marker; a malformed or
  absent permalink yields no marker (no dangle).
