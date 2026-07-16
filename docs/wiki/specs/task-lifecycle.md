---
type: spec
created: 2026-06-03
updated: 2026-07-16
sources:
  - "[[v1]]"
description: "Task substrate: move-stable ^block anchors, splice-guard generated blocks, stamp/reconcile/normalize, lastHumanChangedAt, overdue-only staleness"
---

# Task lifecycle

This spec is normative for Dome's task-lifecycle substrate — the `^block-anchor` line-identity primitive, the three deterministic `dome.daily` task processors (stamp / reconcile / normalize), the `lastHumanChangedAt` freshness rule, **staleness** (overdue-only stale-settle), and the **warden** pattern (model-gated garden processors). It explains why each piece sits where it does and what contract it holds.

The task-lifecycle layer is the machinery behind "close a task in one place, close it everywhere." It introduces no new primitive: a "warden" is a [[wiki/specs/processors|Processor]] (`kind: llm`, garden phase), not a new concept beside Vault / Proposal / Processor / Effect. The four-concept core stays sealed.

## Global task semantics

An unchecked checkbox is not automatically a global Dome task. Inside a daily note, every extracted checkbox or `TODO:` / `Follow up:` directive is intentional daily work and is eligible for task facts and carry-forward. Outside dailies, a plain checkbox is a **local document checklist** unless it carries an explicit task signal: `#task` / `#followup`, a supported priority emoji, a `📅` or ISO due date, or directive syntax. Local checklist lines remain ordinary source Markdown; they do not enter the global open-task projection or daily open-loop surface.

`openLoopSurfaceSources` is the single compiler for this semantic rule. Both `dome.daily.task-index` and `dome.daily.carry-forward` consume that interface, so the fact inventory cannot be broader than the surface inventory. The compiler also owns daily-path recognition, generated-block/frontmatter/fence exclusions, duplicate-anchor handling, semantic bodies, source identity, and origin metadata. Task-line hygiene may still parse local checkboxes to preserve stable syntax and anchors; eligibility is specifically the boundary for global facts and surfaces.

Every global task projects one `dome.daily.open_task` fact. A follow-up projects the same open-task fact plus `dome.daily.followup` as a facet keyed by the same stable identity; it is not a second logical task. Accordingly, `dome.daily.today/v1` keeps `openTasks` as the canonical logical collection and exposes `followups`/`counts.followups` for filtering and metadata. Product totals and task rows consume `openTasks` once rather than adding the follow-up facet again.

## Backlog review read model

`dome.daily.task-backlog` exposes the versioned
`dome.daily.task-backlog.list/v1` document (`TaskBacklog.list`; authenticated
Home route `GET /task-backlog`). It consumes the individual projected
`dome.daily.open_task` origin facts before Today's display dedupe, so two
identical commitments in one file remain two members even when an unanchored
legacy pair shares the same path+body-hash stable id.

The document groups the complete selected set by exact normalized visible
text only. It never uses the conservative near-duplicate/Jaccard heuristic:
review is allowed to show extra units, but must not hide a distinct
commitment. Each exact group is an indivisible pagination unit and carries all
member SourceRefs, block anchors, due/priority metadata, and source context
(projection-backed page title plus path/line/last-human-change time). A group
is reviewable only when every member has a real stamped block anchor;
unanchored members use a transient path+line+normalized-body read identity and
are explicitly `reviewable: false`.

Every member SourceRef is exact reviewed-origin evidence: its `commit` is
re-keyed to the list document's adopted `revision`, and its
line `range`, and `stableId` are required by the wire contract. Block-anchor
uniqueness is checked across the complete open set before grouping or paging.
If one `blockId` appears on multiple origins, every affected member and unit is
`reviewable: false`; their read identities include source location so the
duplicate anchor cannot also create duplicate `dome.task:<blockId>` ids.

Timing classification is deterministic over the group: any past due date is
`overdue`; otherwise any due date is `dated`; otherwise it is `undated`.
Counters cover the full set before paging. The opaque keyset cursor binds to
the adopted commit and a derived-list hash, so list drift produces a typed
`stale-cursor` instead of skipping or repeating work. This read model makes no
closure inference and performs no mutation.

`performSettleBatch` treats these ids and refs as review evidence, not write
authority. Its strict `dome.task-backlog.review/v1` request carries one adopted
`revision` and 1–100 unique keep/defer/close decisions, each with the exact
SourceRef returned by `TaskBacklog.list`. At commit time it re-reads every
reviewed line from that revision, proves that exact line was admitted by the
same `openLoopSurfaceSources` selector as `task-index`, and performs one
line-linear global current-Markdown scan under the controlled-mutation locks.
The selector settings and server-now Done-daily target both come from that
revision's `.dome/config.yaml`; dirty or unadopted `daily_path` changes cannot
widen authority or redirect this reviewed batch.
The scan retains only matched target files and today's daily. A changed
adopted revision, malformed or conflicting decision, missing/duplicate anchor,
mismatched stable id, ineligible current source, or dirty target file rejects
the whole batch before a commit. A unique unchanged eligible line may move:
its anchor remains the identity, and the current path/line becomes the target.

Valid changes are composed per unique file in memory. Every close flips its
origin and contributes one anchor-deduplicated Done-today backlink; only a
backlink bullet parsed inside the bare human-owned `### Done today` section is
evidence, so a pasted link elsewhere cannot suppress the record. All bullets
merge into the daily once. Defers in the same file compose with closes, keeps
participate in identity validation, and a keep-only or exact replay is a
successful no-op. The batch produces at most one ordinary human commit with
one deterministic `Dome-Request` identity. A newer unadopted HEAD is allowed
only when it descends from the reviewed revision and every reviewed task line
still equals either its reviewed bytes or the exact terminal bytes from an
idempotent replay. A lost branch CAS aborts rather than splicing stale
full-file content onto the newer tip. Once adoption advances beyond the
reviewed revision, the same request is deliberately `stale-review`, even if
its prior terminal bytes remain present; the owner must refresh the review.

## Block-anchor identity

A **block anchor** is a trailing `^id` token on a line, separated from the preceding text by whitespace — e.g. `- [ ] ship the thing ^t1a2b3c4`. The grammar is a core primitive at `src/core/block-anchor.ts`: pure (string-only, no IO), Obsidian-compatible, and rebuild-safe. The anchor is stamped *into the markdown itself*, so identity travels with the line.

Identity is anchored to the `^id`, not to a body-hash, because tasks **move**. A task line is rephrased, reordered within a list, or cut from one note and pasted into a daily's open-loop section. A body-hash identity would change on every rephrase and could not survive a move across files. A block anchor is **move-stable**: the same `^id` names the same task no matter which file it currently lives in or how its text is edited. Markdown remains the source of truth (per [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]]); the anchor is durable identity carried in that source.

## Generated-block markers (the splice-guard primitive)

A **generated block** is a marker-delimited region of a markdown page that a processor owns and regenerates — `<!-- <owner>:<block>:start -->` … `<!-- <owner>:<block>:end -->`, where the owner is a dome namespace matching `dome(\.\w+)*` (e.g. `dome`, `dome.daily`, `dome.agent.brief`) and the block name is a slug. Everything outside the markers is human prose; no two processors write the same region — block ownership is disjoint, and the canonical who-writes-which-block-in-the-daily table is [[wiki/specs/daily-surface]] §"Block ownership".

Generated-block bodies are excluded from task extraction with **one deliberate exception**: `dome.daily:captured` (the live capture landing zone) holds task *origins*, not projection copies, so its body stays inside extraction, stamping, normalization, and surfacing — see [[wiki/specs/daily-surface]] §"The `captured` block holds origins, not copies".

The grammar is a core primitive at `src/core/generated-block.ts` — pure (string-only, no IO), the sibling of `src/core/block-anchor.ts` — and it is the **only sanctioned marker implementation**. No processor hand-rolls marker matching, splicing, or stripping; the [[wiki/linters/generated-block-splice-guard]] fence fails CI when a non-test source file constructs marker text without importing the primitive. The primitive carries the two defenses every splice needs:

- **Line-anchored scanning.** A marker counts only when the entire trimmed line is the marker. Prose or fenced *mentions* of marker text, and marker text smuggled mid-line through model-derived content, never bound a block. The first line-anchored pair wins; duplicate pairs, unterminated starts, and orphan ends are reported as anomalies, never silently bound.
- **Body sanitization.** Model-derived block bodies pass through `sanitizeGeneratedBlockBody`, which drops every line carrying a `<!-- dome…` marker comment and strips stray bare `<!--`/`-->` fragments that could recombine downstream. Dome's HTML comments are exclusively generated-block markers, so no legitimate body line ever carries one.

This closes a bug class that shipped three times before the primitive existed: a smuggled second `dome.agent.brief:questions` pair fabricating a questions block in the daily note, injected `dome.daily:*` markers corrupting carry-forward, and promoted preference-rule text carrying the `promoted-preferences` end marker out of `core.md`'s generated block (the marker-injection gotcha named in [[wiki/specs/preferences]]).

**Anomalies are surfaced, never silent.** The scanner's anomaly report (`extra-start` / `extra-end` / `orphan-end` / `unterminated`) makes a smuggle attempt or hand-mangled marker inert — but inert is not invisible. Every splice call site that processes model-derived or human content (the brief's block splice, the preference answer handler's `core.md` splice, carry-forward's daily splice, `render-index`' index-block render) turns each anomaly into one **info-severity** DiagnosticEffect, code `dome.<bundle>.generated-block-anomaly`, message naming the block and anomaly kind, sourceRef anchored at the anomalous marker line. Info by design: an anomaly never blocks adoption (the splice already ignored it). Re-emission dedupes at the diagnostics sink's `(processor_id, code, proposal_id, subject_hash)` constraint, so steady-state re-runs stay quiet. The shared renderer is `generatedBlockAnomalyDiagnostics` in `src/core/generated-block-diagnostics.ts`.

## The three deterministic `dome.daily` task processors

Three garden-phase, `patch.auto` processors maintain task lines. All three are deterministic and idempotent — running them twice against the same adopted tree produces the same result — which keeps them rebuild-eligible under [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]].

- **`dome.daily.stamp-block-id`** stamps a `^id` anchor onto each action-item line that lacks one. Stamping is deterministic and idempotent: an already-anchored line is left untouched, and a freshly stamped line gets a stable id. This is the keystone — once a line carries an anchor, the other processors can name it across moves.
- **`dome.daily.reconcile-tasks`** propagates a *settled* state. When a daily's source-backed open-loop **copy** of a task is marked `[x]` (done) or `[-]` (dropped), reconcile writes that settled state back to the matching open task line in the named origin file (resolved from the copy's `(from [[origin]])` link). Projected copies carry the origin task's trailing `^anchor`, and reconcile matches by that anchor first, so checking a copy and adding a resolution note still closes the origin. Legacy unanchored copies fall back to normalized body matching; when the origin holds two open lines sharing that body the match is ambiguous and is **skipped** rather than guessed. It is **close-in-place**: it edits the origin's checkbox state and never deletes the line. This realizes "close in one place, close everywhere." It declares `inspection: all-readable-markdown` because the origin line may live in any readable markdown file, not just the changed one.
- **`dome.daily.normalize-task-syntax`** performs cosmetic task-syntax normalization (checkbox case, spacing) and **preserves anchors** — normalization must not strip or move the trailing `^id`. It also carries the **captured-today heading repair** for *today's* daily only: duplicate `# Captured today`/`## Captured today` headings (a real pre-D3 vault wart) are merged into the single owned section with every task line and anchor preserved, emitting one `dome.daily.captured-heading-repair` info diagnostic; historical dailies are never touched ([[wiki/specs/daily-surface]] §"Captured-today heading repair"). Same hygiene class — canonicalizing the *shape* of task surfaces without changing task semantics — same triggers, same grant, so it lives here rather than in a fourth processor.

All three are **garden** (not adoption) phase. The reason is the capability-failure surface. In the adoption phase a capability-denied auto-patch becomes a `severity: "block"` diagnostic that blocks the human's adoption — a cosmetic or convenience patch that cannot land would wedge the loop. In the garden phase the same denial degrades quietly (the patch is downgraded or skipped) without blocking the human's commit from being adopted. Task maintenance is convenience work; it must never gate the human. See [[wiki/specs/adoption]] §"The fixed-point adoption loop".

**Obsidian Tasks dashboards are left alone.** A file containing a fenced ` ```tasks ` query block is an Obsidian Tasks plugin dashboard — the plugin parses task lines and would be confused by an injected `^anchor`. All three rewriters skip such files entirely (`isObsidianTasksDashboard`), so a vault's `notes/tasks.md`-style query files stay user-maintained. This is interop, not a capability grant: the grant model matches paths with positive globs only (`notes/*.md` cannot subtract one file), so the exclusion lives in the processor logic. Read-only extraction may still inspect those lines, but `task-index` projects only lines eligible under §"Global task semantics".

## Task origin (source provenance)

A task's origin — where it came from — is one inline marker, ` ([↗](target))`, where `target` is a vault-relative path (a capture file) or a percent-encoded external URL (e.g. a Slack permalink). The grammar is defined once in `action-extraction` (`appendOriginMarker`/`parseOriginMarker`/`stripOriginMarker`); the marker is stripped from the body used for identity, dedup, and reconcile keys, so origin never perturbs `^id` identity. Origin is projected as a parallel `dome.daily.task_origin` fact correlated to the task by stableId (the `open_task`/`followup` fact value stays the clean semantic body), surfaced as a structured field on the task, and rendered as one clickable `↗` affordance in `dome today` (the URL, or `file://` for a vault path). It is distinct from the `(from [[…]])` carry-forward *copy*-provenance suffix. Design: [[cohesive/brainstorms/2026-06-15-daily-phase2]].

## The `lastHumanChangedAt` freshness rule

Daily open-loop recency ranking must reflect *human* edit recency, not engine churn. The problem: stamping a `^block-anchor` (or any garden patch) produces an engine commit, which would reset a naive "last changed" timestamp and make a stale task look fresh.

`src/git.ts` exposes `lastHumanChangedAt` alongside `lastChangedAt`: it is the timestamp of the latest commit touching the line that does **not** carry a `Dome-Run:` trailer — i.e. the latest *human* (non-engine) change. Daily open-loop recency ranking uses `lastHumanChangedAt`, so an engine rewrite such as anchor stamping cannot reset a task's human-edit recency. This depends on the trailer convention pinned by [[wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS]]: engine commits carry `Dome-Run`, human out-of-band commits do not, which makes the human/engine split structurally queryable.

## Staleness

Task staleness is a view concern, not a second durable decision lifecycle. An overdue or old task remains a markdown task and may rank prominently in carry-forward, `today`, `prep`, or `agenda-with`; Dome does not duplicate it into a `QuestionEffect`. The owner settles it directly by block anchor through the settle operation below.

The system previously derived an implicit dismissal signal from repeated same-item impressions across dailies (the "attention-discount" layer, memory-quality M4) and used it both to demote undated items in ranking and as an alternate staleness trigger. It quarantined in production for 13+ days with zero felt loss and was retired in full: the processor, its fact namespace, and both consumption sites (ranking, staleness). Design and rationale: [[cohesive/brainstorms/2026-07-02-pruning-pass-design]] §2.

## The settle operation

Settling a task is a **decision**, not authoring — the same shape as resolving a question (`dome resolve`), not editing a note. `performSettle` (`src/surface/settle.ts`) is the surface collector any client (CLI, HTTP, MCP, PWA) calls to settle a task by its `^block-anchor`. It is the **second commit-or-nothing remote-write operation** beside `performCapture` ([[wiki/specs/capture]] §"The remote-capture seam"), and it inherits capture's trust posture exactly: the change lands as one ordinary **human** commit (no `Dome-*` trailers), and the daemon constructs a Proposal from the branch drift ([[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]]). The seam never calls the engine, never writes a projection, never opens the runtime.

**Addressing.** The task is named by its `^block-anchor` (§"Block-anchor identity") — move-stable, so the same id settles the task wherever it currently lives. `performSettle` scans the vault's markdown for the canonical origin line carrying the anchor. It uses the same exclusion ranges as action extraction, so generated daily projections, frontmatter, and fenced examples cannot win identity lookup; `dome.daily:captured` remains visible because its task lines are origins. The scan includes already-closed origins to preserve idempotency, orders paths deterministically, and fails commit-free with `{ status: "invalid" }` when more than one canonical line carries the anchor rather than guessing between corrupt duplicate identities. An anchor no canonical line carries answers `{ status: "not-found" }` and lands no commit. A caller needs the anchor before it can settle a task: the `dome.daily.today/v1` payload's task rows carry it as the optional `blockId` field ([[wiki/concepts/surface-view-model]] §"Compatible widening") when the line is already anchored, and omit it otherwise — the PWA Brief panel's checkbox is live only on rows that carry one, so a not-yet-anchored task (one garden cascade behind `stamp-block-id`) stays decorative rather than firing a settle that would 404.

**Dispositions:**

- **close** — set the origin line to `- [x]` (done) and, in the SAME commit, append `- <task text> ([[<source page>#^<block>|from]])` under today's daily `### Done today` section (created under `## Done` when absent — `## Done` is shared scaffold + human bullets, [[wiki/specs/daily-surface]] §"Block ownership"). Commit-or-nothing: one commit carries both edits, or none. Idempotent — an already-settled line is a no-op.
- **defer** — rewrite (or insert) the `📅 YYYY-MM-DD` due token to `deferUntil` (required, `YYYY-MM-DD`; a defer without it answers `{ status: "invalid" }`). The task stays open; the origin marker and trailing `^anchor` are preserved.
- **keep** — touch nothing, record nothing, **commit nothing**: `{ status: "settled" }` with no commit.

**Backlog-review batch.** Authenticated Home clients apply the review document
through `POST /task-backlog/review`. The route requires `resolve`, is admitted
as one workspace mutation, records one request receipt, and delegates to the
locked batch contract above. `400 invalid-request` is malformed input;
`409 stale-review` or `conflict` means refresh/repair without outcome
uncertainty; `503 busy` is safe to retry; only `503 outcome-unknown` carries
`recoveryRequired: true`. A successful response reports decision counts, the
single commit or `null`, and whether adoption is `pending` or `unchanged`.

**Shared line mechanics.** The find-by-anchor / flip-if-open / rewrite-`📅` transforms are pure and live once in `dome.daily`'s `task-disposition` module. `performSettle` owns the remote operation and does the filesystem/git work. The commit subject is `settle(<disposition>): <first 50 chars of task text>`.

### Open-loop ranking

Carry-forward, `today`, `prep`, and `agenda-with` all rank open-loop items by **due-date, then recency** — a dated/overdue item outranks an undated one; within a bucket, more-recently-`lastHumanChangedAt`-touched items sort first. There is no discount term: an undated item's rank moves only with its own recency, never with how many times it has previously surfaced.

## Wardens

A **warden** is an LLM-backed garden processor (`execution.class: llm`, `phase: garden`, granted `model.invoke`). It is not a new primitive. Knowledge-integrity review rides the nightly `dome.agent.garden` processor rather than a standalone bundle.

### Knowledge-integrity review folds into `dome.agent.garden`

Knowledge-integrity review is part of the selected semantic-gardening opportunity. The agent may emit **historical-as-ongoing**, **contradiction**, **self-corroborating**, or **inference-as-fact** through `flagIntegrity`, producing a transient `DiagnosticEffect`, never a fact. High-risk findings are warnings; lower-risk findings are info. Stable ids preserve multiple findings per page, and reconciliation clears stale findings.

This holds [[wiki/invariants/MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS]]: a garden `model.invoke` processor is **not** re-run during projection rebuild (model calls are excluded from rebuild), so its judgment must stay transient — surfaced as `DiagnosticEffect`s, never a `FactEffect`.

### Deterministic same-page claim-collision lives in `dome.claims.index`

The mechanical subset — the same normalized claim key asserted with **two or more distinct values on ONE page** — is caught deterministically in the adoption-phase `dome.claims.index` processor, which already parses every claim line. Each collision emits a `warning`-severity `DiagnosticEffect` with code `dome.claims.key-collision`, identified by a per-key `stableId` (the normalized key) so each colliding key surfaces its own diagnostic and self-clears via `resolveStaleDiagnostics` when the page is reconciled. No projection read, no model — the honest deterministic subset the claim lines make free. (This replaces the retired warden's `ctx.projection`-read pre-filter, which was dead code: garden phase omits the projection, so the read always returned nothing.)

### Stale-claim flags resolve via supersession

When integrity review flags a **stale claim** (a page asserting something the vault has since outgrown), the durable resolution is usually not a rewrite — it is the supersession status flip from [[wiki/specs/page-schema]] §"Supersession (ADR pattern)": set `status: superseded` + `superseded_by: "[[<current page>]]"` on the stale page (or move the stale portion under a `## Superseded` section on a mixed page). The flip lives in markdown, so it survives rebuild without violating [[wiki/invariants/MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS]] — the transient model judgment becomes durable through a human or agent editing the page; the diagnostic self-clears via `resolveStaleDiagnostics` when the reconciled page is next inspected, and lint + ranking take it from there deterministically.

## Related

- [[wiki/invariants/MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS]] — the hard rule wardens hold: no garden `model.invoke` processor declares `graph.write`
- [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]] — why model judgment must not become a durable fact
- [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]] — anchors live in markdown; answers live in `answers.db`
- [[wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS]] — the `Dome-Run` split behind `lastHumanChangedAt`
- [[wiki/specs/capabilities]] — `model.invoke`, `graph.write`, `patch.auto`, `question.ask` tiers
- [[wiki/specs/processors]] — phases, triggers, `execution.class: llm`, idempotency
- [[wiki/specs/effects]] — `QuestionEffect`, `PatchEffect`, `FactEffect`
- [[wiki/specs/adoption]] — why garden-phase denials don't block the human
- [[wiki/specs/daily-surface]] — the daily note as a product surface; where the hygiene processors sit in the 24-hour choreography
- [[wiki/gotchas/garden-cascade-cap]] — why the briefing warden is cron-only
