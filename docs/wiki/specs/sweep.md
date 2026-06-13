---
type: spec
created: 2026-06-10
updated: 2026-06-12
sources:
  - "[[cohesive/brainstorms/2026-06-09-meaning-consolidation-claims-and-sweeper]]"
description: "Nightly dome.agent.sweep integration: deterministic queue, settlement via destination sources: links (ledger advisory), safe cursor, escalation"
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

1. The destination's frontmatter `sources:` list contains a wikilink to the material — this is the authoritative settlement check (markdown, not `.dome/state`).
2. The ledger records a `no-op`, `questioned`, or `escalated` disposition for the pair. `integrated` rows do **not** settle: the sources-link in the destination's frontmatter is the authoritative record for integrations — an `integrated` row without the link means the sub-proposal was rejected, and the pair must re-queue. `failed` rows also do **not** settle; the pair re-queues and the failed count increments toward escalation. `escalated` rows settle **terminally** — the pair stops consuming attempts and stops holding the cursor back; see §"Advisory ledger grammar".

**Ranking and cap:** Items rank by `(materialDate desc, mentions desc, destination asc)` for full determinism. The queue is capped at `sweep_max_items` (default 20); over-cap items re-queue the next night. The processor emits an info diagnostic when the cap truncates the queue (no silent drops).

**Oldest-unswept tracking:** The queue exposes `oldestUnswept` — the oldest material date among the cap-dropped (over-cap) candidates only; failed pairs feed the separate `oldestFailed` term via `failedDates` tracked in the processor — which together feed the safe-cursor contract.

## Settlement-by-sources (authoritative)

Settlement is the wikilink `[[material-path-without-.md]]` appearing in the destination page's frontmatter `sources:` list. This is written atomically in the same patch as the integration text, so it is always in sync. The four accepted link forms are `[[m]]`, `[[m|alias]]`, `[[m.md]]`, and `[[m.md|alias]]` — all matched by substring on each `sources:` list line in both the queue's frontmatter slice check (`isSettledBySources`) and the processor's enforcement function (`containsMaterialLink`).

The advisory ledger's `integrated` rows are **record-only** — the queue does not settle on them. When the sub-proposal carrying the integration patch was rejected by the engine, the ledger row would be present but the sources link would be absent; treating the row as settled would suppress re-queueing forever. Only `no-op`, `questioned`, and `escalated` ledger rows settle (`no-op`/`questioned` only save re-judging, never mask a failed write; `escalated` is the deliberate terminal record for a poison pair).

## Advisory ledger grammar

The sweep ledger (`meta/sweep-ledger.md`, config key `sweep_ledger_path`) is committed markdown. It is **advisory** — correctness never depends on it alone. Its purpose: carry the scan cursor, no-op records that save re-judging, escalated records (poison-pair terminal rows — hand-delete to re-arm), and per-run sections the brief digest renders.

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
| `questioned` | Uncertain, or a size guard refused to start the run; a QuestionEffect was emitted for the owner. Settles the pair (saves re-judging). |
| `failed` | A run error occurred, or the shrink guard rejected the proposed edit; pair is not settled, re-queues. After 3 failures the processor escalates instead. |
| `escalated` | The repeated-failure threshold's **terminal record**, written alongside the escalation question: the pair is settled — excluded from the queue, no longer holding the cursor back via its `materialDate` — and stops burning model budget. |

`questioned` and `escalated` deliberately mean different things even though both ride an escalation-shaped question: the **oversized-page guards** record `questioned` (the pair never reached the model for size reasons — a judgment-free refusal), while the **repeated-failure threshold** records `escalated` (the pair reached the model ≥ 3 times and kept failing — a poison pair). **Re-eligibility after an escalation is deliberately manual:** the owner hand-deletes the `escalated` row from the ledger; there is no retry-granted flow.

The ledger is written once per run as a final advisory patch (cursor + run section). Its loss costs only re-judging already-settled pairs (and re-arming escalated pairs); settlement-by-sources in destination frontmatter holds.

## Safe-cursor contract

The processor must use `safeCursor({ today, oldestUnswept, oldestFailed })` when writing the cursor:

- The cursor may not advance past any dropped (over-cap) or failed material.
- `oldestFailed` is the minimum `materialDate` among tonight's failed items (null if none).
- The `windowDays` floor is the eventual decay backstop — even a very old failed pair cannot hold the cursor back indefinitely past the window floor.
- A pair settled by an `escalated` row is no longer failed material: it stops feeding `oldestFailed`, so the cursor advances past it (that is half the point of the terminal record — the other half is queue exclusion).

## Per-item write vocabulary

The model receives a single destination page and a single material file. It may:

- **Append** a new dated narrative section (`## YYYY-MM-DD — <what happened>`).
- **Update** existing claim lines (`**Key:** value ... ^c…`) in place when the material supersedes them — never change the `^c…` anchor.
- **Extend** frontmatter `sources:` to add the material wikilink (mandatory provenance step; the processor enforces this deterministically via `ensureSourcesLink` even if the model omits it).
- **Add** wikilinks to the destination body.

The model must **not** delete or rewrite existing narrative prose, and must not touch any file other than the destination.

**Single-destination boundary:** Each queue item runs a separate agent conversation scoped to exactly one destination. The `editDestination` tool rejects any write to a path other than the current item's destination — the worst injection outcome is bad text on one page. Oversized-section guard: a proposed section exceeding 4000 characters is capped before being stored in question metadata.

**Shrink guard:** After `ensureSourcesLink` runs, if the proposed content is shorter than `destContent.length − max(200 chars, 10%)`, the patch is refused: a significant shrink on an append-only charter means the model rewrote from truncated context or vandalism. The pair records a `failed` row and re-queues; the `dome.agent.sweep-shrink-rejected` warning diagnostic is emitted. `failed` rows from the shrink guard count toward the escalate-after-3 contract.

**Oversized-destination guard:** If the destination content exceeds 20,000 characters (the same per-read cap applied to all agent tool reads via `MAX_READ_CHARS`), no agent run is started — a full-page rewrite from a truncated read would amputate the tail. Instead the processor escalates immediately: a `dome.agent.sweep:escalate:<m>-><d>` question is emitted asking the owner to integrate manually or skip, and a `questioned` row is written to the ledger. Destinations keep the tighter 20k cap because they are rewritten wholesale.

**Oversized-material guard:** If the *material* content exceeds 100,000 characters (`MATERIAL_READ_CHARS`), the agent run is also skipped. Integrating from a truncated material head would write the sources link and permanently settle the pair with the tail never seen — a "no capture left behind" violation. The same escalation path applies: `dome.agent.sweep:escalate:<m>-><d>` question with `options: ["skip"]`, `automationPolicy: "owner-needed"`, and a `questioned` ledger row. The material cap is larger (100k vs 20k for destinations) because material is quoted read-only context embedded into the task turn — the cap bounds prompt size only, not rewrite-amputation risk. Real dailies routinely run 20–30k characters, so the former shared 20k cap was escalating valid pairs every night. Together, the two oversized guards ensure neither side of a pair can reach the model in a silently truncated state.

**Night-overlay same-destination composition:** When two queue items in the same night target the same destination, the processor threads a per-night overlay map. After item 1 writes its integration, its resulting content is stored in the overlay keyed by the destination path. Item 2's agent reads the destination via the overlay (not the stale snapshot), so its patch is applied on top of item 1's content — both integrations land in a single destination page without clobbering each other. The overlay also means item 1's newly added sources link is visible to item 2's settlement check.

## Question namespaces

The sweep emits questions in two namespaces under the shared `dome.agent.sweep:` prefix:

- `dome.agent.sweep:uncertain:<material>-><destination>` — uncertain-integration questions (options `["integrate", "skip"]`). The question carries `metadata.proposedSection` (capped at 4000 chars) so the answer handler can apply the integration without another model call.
- `dome.agent.sweep:escalate:<material>-><destination>` — escalations (options `["skip"]` only; no `proposedSection`), raised by the repeated-failure threshold (≥ 3 failures; an `escalated` ledger row is written alongside) and by the oversized-page guards (a `questioned` row). The escalation carries `automationPolicy: "owner-needed"`.

**Answer-handler semantics (`dome.agent.sweep-answer`):**

- `integrate` answer on an `uncertain` key: the handler reads the destination, appends `metadata.proposedSection` as a dated section, runs `ensureSourcesLink`, and emits one auto patch. The `:: questioned` ledger row already settles the pair; once the patch lands, settlement-by-sources holds too.
- `skip` answer on an `uncertain` key: no effects. The `questioned` ledger row prevents re-queueing.
- Any answer on an `escalate` key: **no-op settle** — the handler records nothing and never re-queues the pair; the answer itself closes the question, and the ledger row (an `escalated` row for the failure threshold, a `questioned` row for the size guards) already settles the pair. The owner re-arms an escalated pair only by hand-deleting its row from the ledger.
- Malformed metadata: warning diagnostic, no effects, never throws.

**Retry idempotency:** Question idempotency keys carry the kind segment: `dome.agent.sweep:uncertain:<material>-><destination>` and `dome.agent.sweep:escalate:<material>-><destination>`. If the answer-handler fires more than once (at-least-once dispatch), the re-fire guard is section-text presence: the handler checks `existingContent.includes(proposedSection.trim())`. When the section is already present, no second append is emitted; `ensureSourcesLink` is still called, and a patch is emitted only when the sources link was somehow missing — exactly recovering the link-only failure mode.

## Brief digest block

The brief reads the sweep ledger and renders the most recent `## Run <date>` section's rows as the `dome.agent.brief:integrated` generated block — deterministic, never model-written; its place in the daily-note package is normative at [[wiki/specs/daily-surface]] §"Block ownership":

- `integrated` rows → `- [[destination]] ← [[material]]`
- `questioned` rows → `- ⚠ pending your answer: [[destination]] ← [[material]]`
- `no-op` and `failed` rows are not rendered (the brief is signal, not log).
- `escalated` rows are not rendered either: the escalation's question already renders in the brief's deterministic open-questions block, and a second bullet would double-surface the same decision.

When the ledger is absent or the current day has no run section, the block is omitted entirely.

## Config keys

All under `extensions.dome.agent.config` in `.dome/config.yaml`:

| Key | Default | Meaning |
|---|---|---|
| `sweep_ledger_path` | `meta/sweep-ledger.md` | Vault-relative path to the advisory ledger markdown file. Custom paths must have matching `read` + `patch.auto` grant entries. |
| `sweep_window_days` | `14` | Lookback window in days. Pairs older than `today − sweep_window_days` are not queued even if the cursor is older. |
| `sweep_max_items` | `20` | Maximum queue items per night. Over-cap items re-queue the next night. |
| `sweep_targets` | `["wiki/entities/", "wiki/concepts/"]` | Path prefixes for destination discovery. Must be a non-empty array of relative path prefixes. All entries must be covered by the bundle's `patch.auto` grant (broker-enforced). |

**Grant validation:** The processor validates that each `sweep_targets` prefix is covered by the manifest's `patch.auto` paths. A prefix outside the grant degrades to the default with a warning diagnostic rather than blocking the night's run.

## Processors

| Processor | Phase | Trigger | Kind | Effect |
|---|---|---|---|---|
| `dome.agent.sweep` | garden | cron `0 3 * * *` | LLM | Per-queue-item auto patches + QuestionEffects + advisory ledger patch. |
| `dome.agent.sweep-answer` | garden | answer (prefix `dome.agent.sweep:`) | deterministic | Apply owner-approved integrations or dismiss escalations; no ledger write (the `questioned`/`escalated` row already settles). |

The pair is registered as the `dome.meaning.integration` maintenance loop.

## Three engine-forced deltas from the design doc

1. **`dome.agent.sweep-queue` is a pure library, not a processor.** Scheduled garden processors receive empty `changedPaths` and there is no inter-processor data channel beyond projections; the deterministic spine lives as `lib/sweep-queue.ts` called inside the sweep processor. Same determinism guarantee; simpler wiring.
2. **No `.dome/state` sweep store — settlement lives in markdown.** Processors can only persist state through the eleven effect kinds; nothing writes arbitrary durable operational state. Additionally, patches are whole-content writes, so N per-item ledger appends in one run would clobber each other. Therefore: settlement = destination `sources:` wikilink (atomic with the integration patch); the ledger is advisory (cursor, no-op lines, run summary), written once per run as a separate patch whose loss is harmless.
3. **v1 material scope = `wiki/dailies/*.md` + `inbox/processed/*.md`; v1 destinations = existing pages only.** Both material roots are append-only/immutable by convention once the day closes, which makes hash-free sources-link settlement sound. `notes/**` + `wiki/sources/**` as material, and new-stub-page creation, are deferred.
