---
type: spec
created: 2026-06-10
updated: 2026-06-10
sources:
  - "[[cohesive/brainstorms/2026-06-09-meaning-consolidation-claims-and-sweeper]]"
---

# Sweep

This spec is normative for the `dome.agent.sweep` nightly meaning-integration processor and its answer handler `dome.agent.sweep-answer`. For the design rationale and brainstorm history see [[cohesive/brainstorms/2026-06-09-meaning-consolidation-claims-and-sweeper]]. Three engine-forced deltas from that design doc are recorded at the bottom.

## Goal

"No capture left behind." Every daily note and processed inbox capture that concerns an existing wiki page must be integrated into that page — even when no foreground session touched the pair. The sweep runs nightly at 03:00 (cron `0 3 * * *`), after `dome.agent.consolidate` (02:00) and before the brief (05:30), so the brief's "Integrated overnight" block reflects the night's run.

## Queue rules

The deterministic sweep queue (pure library `lib/sweep-queue.ts`) decides *what* must be integrated before the model sees anything.

**Material:** `wiki/dailies/YYYY-MM-DD.md` files and `inbox/processed/*.md` files whose filename carries a leading `YYYY-MM-DD` timestamp, where the material date satisfies:

- `window_floor ≤ date < today` (today's daily is still being written and is excluded)
- `window_floor = today − sweep_window_days` (default 14 days)
- **Cursor narrowing:** when the sweep ledger carries a cursor, `date > cursor` further restricts the window. The cursor is the safe floor — only ever narrowing — and `window_floor` is the decay backstop so stale material cannot hold the cursor back forever.

**Destinations per material:** (a) wikilink targets parsed from the material (`[[...]]`) that resolve to existing pages under the `sweep_targets` globs; (b) title mentions — an existing target page whose title (basename sans `.md`, hyphens/underscores → spaces) appears case-insensitively in the material body. Titles shorter than 4 characters are excluded to avoid noise. Material never targets itself; dailies are never destinations.

**Settlement skip (idempotency):** A (material, destination) pair is dropped when:

1. The destination's frontmatter `sources:` list contains `[[material-without-.md]]` in any form — this is the authoritative settlement check (markdown, not `.dome/state`).
2. The ledger records an `integrated`, `no-op`, or `questioned` disposition for the pair. `failed` rows do **not** settle; the pair re-queues and the failed count increments toward escalation.

**Ranking and cap:** Items rank by `(materialDate desc, mentions desc, destination asc)` for full determinism. The queue is capped at `sweep_max_items` (default 20); over-cap items re-queue the next night. The processor emits an info diagnostic when the cap truncates the queue (no silent drops).

**Oldest-unswept tracking:** The queue exposes `oldestUnswept` — the oldest material date among all unsettled in-window pairs — which feeds the safe-cursor contract.

## Settlement-by-sources (authoritative)

Settlement is the wikilink `[[material-path-without-.md]]` appearing in the destination page's frontmatter `sources:` list. This is written atomically in the same patch as the integration text, so it is always in sync. The four accepted link forms (bare path, `[[path]]`, `"[[path]]"`, `'[[path]]'`) are all recognized by the queue's frontmatter slice check.

The advisory ledger's `integrated` rows duplicate this signal for performance (skip re-reading every destination frontmatter). Both signals settle the pair.

## Advisory ledger grammar

The sweep ledger (`sweep-ledger.md`, config key `sweep_ledger_path`) is committed markdown. It is **advisory** — correctness never depends on it alone. Its purpose: carry the scan cursor, no-op records that save re-judging, and per-run sections the brief digest renders.

```markdown
# Sweep ledger

cursor:: 2026-06-09

## Run 2026-06-10

- [[wiki/dailies/2026-06-09]] -> [[wiki/entities/alice-henshaw]] :: integrated
- [[wiki/dailies/2026-06-09]] -> [[wiki/entities/tokka]] :: no-op
- [[inbox/processed/2026-06-09T23-04-11-thought]] -> [[wiki/concepts/transformer-hook]] :: questioned
```

**Dispositions:**

| Disposition | Meaning |
|---|---|
| `integrated` | Model wrote a section + sources link; destination updated. |
| `no-op` | Model made no edit (material had nothing meaningful for this destination). |
| `questioned` | Uncertain; a QuestionEffect was emitted for the owner. |
| `failed` | A run error occurred; pair is not settled, re-queues. After 3 failures the processor escalates to a question instead. |

The ledger is written once per run as a final advisory patch (cursor + run section). Its loss costs only re-judging already-settled pairs; settlement-by-sources in destination frontmatter holds.

## Safe-cursor contract

The processor must use `safeCursor({ today, oldestUnswept, oldestFailed })` when writing the cursor:

- The cursor may not advance past any dropped (over-cap) or failed material.
- `oldestFailed` is the minimum `materialDate` among tonight's failed items (null if none).
- The `windowDays` floor is the eventual decay backstop — even a very old failed pair cannot hold the cursor back indefinitely past the window floor.

## Per-item write vocabulary

The model receives a single destination page and a single material file. It may:

- **Append** a new dated narrative section (`## YYYY-MM-DD — <what happened>`).
- **Update** existing claim lines (`**Key:** value ... ^c…`) in place when the material supersedes them — never change the `^c…` anchor.
- **Extend** frontmatter `sources:` to add the material wikilink (mandatory provenance step; the processor enforces this deterministically via `ensureSourcesLink` even if the model omits it).
- **Add** wikilinks to the destination body.

The model must **not** delete or rewrite existing narrative prose, and must not touch any file other than the destination.

**Single-destination boundary:** Each queue item runs a separate agent conversation scoped to exactly one destination. The `editDestination` tool rejects any write to a path other than the current item's destination — the worst injection outcome is bad text on one page. Oversized-page guard: a proposed section exceeding 4000 characters is capped before being stored in question metadata.

**Night-overlay same-destination composition:** If two queue items target the same destination in one night, they produce two independent patches. The engine applies each via the normal adoption cascade; they compose naturally (one appends a section, the other may edit a claim line).

## Question namespaces

The sweep emits questions in two namespaces under the shared `dome.agent.sweep:` prefix:

- `dome.agent.sweep:uncertain:<material>-><destination>` — uncertain-integration questions (options `["integrate", "skip"]`). The question carries `metadata.proposedSection` (capped at 4000 chars) so the answer handler can apply the integration without another model call.
- `dome.agent.sweep:escalate:<material>-><destination>` — escalations after ≥3 failures (options `["skip"]` only; no `proposedSection`). The escalation carries `automationPolicy: "owner-needed"`.

**Answer-handler semantics (`dome.agent.sweep-answer`):**

- `integrate` answer on an `uncertain` key: the handler reads the destination, appends `metadata.proposedSection` as a dated section, runs `ensureSourcesLink`, and emits one auto patch. The `:: questioned` ledger row already settles the pair; once the patch lands, settlement-by-sources holds too.
- `skip` answer on either key: no effects. The `questioned` ledger row prevents re-queueing.
- Malformed metadata: warning diagnostic, no effects, never throws.

**Retry idempotency:** The question idempotency key is `dome.agent.sweep:<material>-><destination>`. If the answer patch is retried, `ensureSourcesLink` is idempotent; the section append is guarded by the sources check (if the link is already present, the answer was already applied).

## Brief digest block

The brief reads the sweep ledger and renders the most recent `## Run <date>` section's rows as a deterministic block (never model-written):

- `integrated` rows → `- [[destination]] ← [[material]]`
- `questioned` rows → `- ⚠ pending your answer: [[destination]] ← [[material]]`
- `no-op` rows are not rendered (the brief is signal, not log).

When the ledger is absent or the current day has no run section, the block is omitted entirely.

## Config keys

All under `extensions.dome.agent.config` in `.dome/config.yaml`:

| Key | Default | Meaning |
|---|---|---|
| `sweep_ledger_path` | `sweep-ledger.md` | Vault-relative path to the advisory ledger markdown file. Custom paths must have matching `read` + `patch.auto` grant entries. |
| `sweep_window_days` | `14` | Lookback window in days. Pairs older than `today − sweep_window_days` are not queued even if the cursor is older. |
| `sweep_max_items` | `20` | Maximum queue items per night. Over-cap items re-queue the next night. |
| `sweep_targets` | `["wiki/entities/", "wiki/concepts/"]` | Path prefixes for destination discovery. Must be a non-empty array of relative path prefixes. All entries must be covered by the bundle's `patch.auto` grant (broker-enforced). |

**Grant validation:** The processor validates that each `sweep_targets` prefix is covered by the manifest's `patch.auto` paths. A prefix outside the grant degrades to the default with a warning diagnostic rather than blocking the night's run.

## Processors

| Processor | Phase | Trigger | Kind | Effect |
|---|---|---|---|---|
| `dome.agent.sweep` | garden | cron `0 3 * * *` | LLM | Per-queue-item auto patches + QuestionEffects + advisory ledger patch. |
| `dome.agent.sweep-answer` | garden | answer (prefix `dome.agent.sweep:`) | deterministic | Apply owner-approved integrations or dismiss escalations; no ledger write (the `questioned` row already settles). |

The pair is registered as the `dome.meaning.integration` maintenance loop.

## Three engine-forced deltas from the design doc

1. **`dome.agent.sweep-queue` is a pure library, not a processor.** Scheduled garden processors receive empty `changedPaths` and there is no inter-processor data channel beyond projections; the deterministic spine lives as `lib/sweep-queue.ts` called inside the sweep processor. Same determinism guarantee; simpler wiring.
2. **No `.dome/state` sweep store — settlement lives in markdown.** Processors can only persist state through the eleven effect kinds; nothing writes arbitrary durable operational state. Additionally, patches are whole-content writes, so N per-item ledger appends in one run would clobber each other. Therefore: settlement = destination `sources:` wikilink (atomic with the integration patch); the ledger is advisory (cursor, no-op lines, run summary), written once per run as a separate patch whose loss is harmless.
3. **v1 material scope = `wiki/dailies/*.md` + `inbox/processed/*.md`; v1 destinations = existing pages only.** Both material roots are append-only/immutable by convention once the day closes, which makes hash-free sources-link settlement sound. `notes/**` + `wiki/sources/**` as material, and new-stub-page creation, are deferred.
