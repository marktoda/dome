---
type: spec
created: 2026-06-10
updated: 2026-06-15
sources:
  - "[[daily]]"
  - "[[wiki/specs/task-lifecycle]]"
  - "[[wiki/specs/autonomous-agents]]"
  - "[[wiki/specs/sweep]]"
description: "Daily note as product surface: normative section and block-ownership tables, 24-hour edition choreography, wake-tick ordering, degradation ladder"
---

# Daily surface

This spec is normative for the daily note as a *product surface* — the one file where the system and the owner meet. The mechanism layer (block grammar, splice guard, anchors, agents) is specified elsewhere and pointed at, not duplicated: [[wiki/specs/task-lifecycle]] owns block-anchor identity and the deterministic task processors, [[wiki/specs/autonomous-agents]] owns the brief's agent contract, [[wiki/specs/sweep]] owns the overnight integration whose digest the edition renders. This spec owns the *package*: which sections exist, who writes which block, the overnight choreography, and how the morning edition degrades.

Plan of record: [[daily]] (the daily-surface plan). This spec is its phase D1 contract with the D2 (one yesterday block), D3 (Captured today, owned), and D4 (the close scaffold) deltas landed as shipped behavior.

## The three acts

The daily has exactly three jobs:

1. **Morning Edition (02:00–06:00, compiled).** One overnight pipeline — consolidate → sweep → calendar → edition compile — producing one package in today's daily note, with an explicit degradation ladder (§"The degradation ladder").
2. **Live Surface (daytime).** Capture lands in owned regions; hygiene (anchors, normalization, reconcile, discounting) is invisible; `today` / `prep` / `agenda-with` are read-only projections, never writers.
3. **Close (evening, 21:30, scaffolded).** First-class since D4: `dome.daily.close-scaffold` drafts the deterministic `dome.daily:close` block under `## Done` — done candidates from today's settled surface, the still-open line-up, and a story pointer. The human's job shrinks to keep/delete plus the story; `## Story of the Day` stays purely human, never model- or machine-written ([[daily]] decision ledger 3). The close's outputs are the next edition's inputs (§"The close block"): tomorrow's mechanical yesterday fallback prefers the close over raw section scraping, and a written-but-emptied close degrades to an explicit "yesterday's close was empty" line instead of silent thinness.

## The 24-hour choreography

All times are vault-local; cron triggers fire only while the compiler host (`dome serve`) is running. The pipeline is ordered so each stage's output is the next stage's input.

| When | Processor / actor | Bundle | Role in the package |
|---|---|---|---|
| 02:00 | `dome.agent.consolidate` | dome.agent | Contractive janitor over recent drift — the graph the edition reads is already tidied. |
| 03:00 | `dome.agent.sweep` | dome.agent | Meaning integration ("no capture left behind"); writes tonight's `## Run <date>` section into the sweep ledger, which the edition digests. |
| ~05:15+ | `dome.sources.fetch` — the opt-in calendar **subscription** ([[wiki/specs/sources]]) | dome.sources | Engine-scheduled but never engine-written, and only when the fetch command is **deterministic**: the shipped connector-backed `claude -p` template is foreground-only and will not produce a file from the daemon ([[wiki/specs/sources]] §"Connector-backed fetch is foreground-only"). With a deterministic fetcher configured, the calendar subscription is *due* at 05:10; the actual dispatch happens on the next 15-minute fetch tick — ~05:15 at the earliest, later if an attempt needs a backoff retry — still ahead of the 05:30 brief: the effect goes through the outbox and the **vault-configured fetch command** writes + commits `sources/calendar/<today>.md` as an ordinary non-engine commit before the brief. Vaults that keep an external launchd/cron fetcher, or write the file from a foreground morning session, get the identical file contract ([[wiki/specs/vault-layout]] §"Populating the calendar file"). A missing file means "no agenda known". |
| ~05:15+ (opt-in) | `dome.sources.fetch` — the optional Slack **subscription** ([[wiki/specs/sources]] §"The Slack stance") | dome.sources | Same machinery as the calendar row, **never shipped on**, and same caveat: the shipped connector-backed fetch is foreground-only, so a daemon-driven slack subscription needs a deterministic fetcher swapped in ([[wiki/specs/sources]] §"Connector-backed fetch is foreground-only"). When `sources/slack/<today>.md` is present — written by such a subscription *or* the owner's foreground morning session — it carries the overnight digest in the slack-day shape ([[wiki/specs/vault-layout]] §"`sources/slack/YYYY-MM-DD.md`"), and the 05:30 brief parses it defensively and injects it into its task turn as untrusted data ([[wiki/specs/autonomous-agents]] §"`dome.agent.brief`"). A missing file means "no digest known" and adds nothing. |
| 05:20 | `dome.agent.active-projects` | dome.agent | Refreshes `core.md`'s `dome.agent:active-projects` generated block from the dailies' open-loop tallies ([[wiki/specs/autonomous-agents]] §"`dome.agent.active-projects`") — after the 05:15 index render, before the brief, so the brief's core-memory injection reads fresh project tallies. Schedule-only by design, to batch core-memory churn into the morning refresh. |
| 05:25 | `dome.daily.compose-blocks` | dome.daily | Deterministic block compile: questions / agenda / integrated / sources rendered from current inputs; also fires on `questions.changed` + source-file + sweep-ledger signals all day. |
| 05:30 | `dome.agent.brief` | dome.agent | **The narrative compile.** Composes the brief's three narrative blocks into today's daily (creating the shared skeleton when absent, so create-daily later no-ops): today's forward narrative, yesterday digest (replacing the mechanical fallback body wholesale), meetings prep prose. Gated by the compose-record: a deterministic pre-pass hashes the current inputs (calendar, slack, today's sweep-ledger section, yesterday's daily) against the record — all-match is a zero-model no-op, capped at 3 model composes/day (§"Wake-tick choreography"). Also triggers on `file.created` for `sources/calendar/*.md` + `sources/slack/*.md` — the late-source re-compose. |
| 06:00 | `dome.daily.create-daily` | dome.daily | Skeleton fallback: creates today's daily when nothing else did; seeds the unified `dome.agent.brief:yesterday` block with the mechanical fallback body (§"The one yesterday block"). |
| 06:00 | `dome.daily.stale-task-warden` | dome.daily | Stale-settle warden: emits one `settle-stale` owner question per overdue-≥14-day task (overdue-only; undated tasks are never candidates), capped at 8 worst-first. The companion `dome.daily.settle-stale-answer` handler applies the owner's close/defer/keep answer deterministically. Normative at [[wiki/specs/task-lifecycle]] §"Staleness". |
| 06:00 + on-commit | `dome.daily.carry-forward` | dome.daily | Raises the ranked `dome.daily:open-loops` surface; re-fires on every adopted commit so the surface tracks the live vault. Seeds the yesterday fallback block when (and only when) it is absent. |
| on-commit (capture) | `dome.agent.ingest` | dome.agent | Routes a capture's tactical tasks into today's daily — task-shaped lines spliced into the `dome.daily:captured` block by the tool seam (the model never positions). |
| on-commit (daytime) | `dome.daily.stamp-block-id`, `normalize-task-syntax`, `reconcile-tasks`, `task-index` | dome.daily | The hygiene set: anchor stamping, cosmetic normalization, close-in-one-place reconcile, task facts. Normative at [[wiki/specs/task-lifecycle]]. |
| on-demand | `today`, `prep`, `agenda-with` | dome.daily | View-phase read-only projections of the live surface. |
| 21:30 | `dome.daily.close-scaffold` | dome.daily | The Close: writes the deterministic `dome.daily:close` scaffold under `## Done` (§"The close block"). **Schedule-only by design — no file trigger.** The close is a ritual moment, not a live surface: it snapshots the day once at close time, and a commit-triggered rewrite would fight the human's keep/delete edits inside the block. |

### Wake-tick choreography (laptop-first)

On a laptop-resident daemon the 05:05–06:00 timeline above usually arrives as a single wake tick: the machine slept through several crons, each missed interval collapses to one fire ([[wiki/specs/projection-store]] §"`schedule_cursors`"), and everything is due at once. Two mechanisms keep the burst producing the same package as the spread-out timeline:

1. **Same-tick fires dispatch in cron-time order.** The scheduler (`src/engine/operational/scheduler.ts`) evaluates every due processor *before* dispatching any of them, then dispatches in the order their crons came due — processor id as the tiebreak; a brand-new processor with no cursor and no ledger history became due "now" and sorts after every missed cron. A wake burst therefore replays the choreography: sources fetch (05:10) before the index render (05:15) before active-projects (05:20) before compose-blocks (05:25) before the brief (05:30) before create-daily (06:00) — never registry (alphabetical-by-id) order. The contract is recorded in [[wiki/specs/processors]] §"Implementation status" and [[wiki/specs/projection-store]] §"`schedule_cursors`".
2. **The brief re-composes when its inputs change (the compose-record gate).** Ordering alone cannot close the gap: `dome.daily.compose-blocks` (05:25) and the brief (05:30) both dispatch before their inputs are guaranteed final — the fetch *dispatch* is ordered first, but the fetch completes asynchronously (outbox → command → commit → adoption), so a wake-tick brief can still compose before today's calendar/slack file exists, or before a late sweep-ledger section lands. The brief therefore also triggers on `file.created` for `sources/calendar/*.md` and `sources/slack/*.md`. On every fire (cron or signal), a deterministic pre-pass hashes the current material inputs — calendar, slack, today's sweep-ledger section, yesterday's daily — and compares them against the `dome.agent.brief:compose-record` block's per-input content hashes (§"Block ownership"): all-match is a zero-model, zero-effect no-op; any mismatch re-composes all three narrative blocks and rewrites the record. Re-composes are capped at **3 model composes per day** — an info diagnostic fires beyond the cap, and the deterministic blocks (compose-blocks' own 05:25 pipeline) keep updating live regardless. Normative at [[wiki/specs/autonomous-agents]] §"`dome.agent.brief`".

The edition pipeline is registered as the **`dome.daily.edition` maintenance loop** (`src/extensions/maintenance-loops.ts`): required processors `dome.agent.brief` + `dome.daily.create-daily` + `dome.daily.carry-forward` + `dome.daily.close-scaffold`, with the calendar source named as path evidence and `dome.sources.fetch` as an **optional** processor (subscriptions are per-vault opt-in; the loop schema has no free-text notes field, so the calendar feed's external, command-written nature is recorded in the loop's risks). The 02:00/03:00 stages stay owned by their own loops (`dome.link-concept.coherence`, `dome.meaning.integration`) — the edition loop covers the *compile*, not the whole night. The close joins the edition loop rather than getting a tenth loop of its own: the daily package is one design unit (the three acts of one console), the close's sole machine purpose is to feed the next morning's compile, and a separate `dome.daily.close` loop would duplicate the edition's evidence and surfaces while answering the same question ("did my day's package happen") in two places.

## The section contract

The skeleton (`renderDailySkeleton` in `assets/extensions/dome.daily/processors/daily-shared.ts`) is shared by `create-daily` and the brief — there is exactly one skeleton shape. Every `##` heading has a declared job, owner, and machine readers.

**This table is normative ([[daily]] decision ledger 4): any future processor that writes into a daily note must claim a row here (and a block row in §"Block ownership") before shipping.** Unclaimed writes are how the two-yesterdays and orphan-heading accretions happened.

| `##` heading | Job | Owner | Generated blocks hosted | Machine readers |
|---|---|---|---|---|
| `Captured today` | The live capture landing zone — where the day's new tactical tasks land. First content section, above `Start Here` (matching the real-vault convention this section formalizes). | Shared: the skeleton renders it (empty block); `dome.agent.ingest` appends inside the block through its tool seam; `dome.agent.brief` may append actionable Slack/meeting findings via `addTask` through the same validated captured splice; humans may add task lines too. | `dome.daily:captured`. | The full task pipeline — captured lines are **origins, not copies**, so this is the one generated block whose body is *included* in task extraction (`task-index`, `stamp-block-id`, `normalize-task-syntax`, carry-forward ranking, search indexing). |
| `Start Here` | The first read of the morning — the edition's front page. | Shared: `dome.daily.compose-blocks` (deterministic blocks) + `dome.agent.brief` (narrative blocks) + optional human prose. | `dome.agent.brief:today` (model-written forward narrative, splice top — CB-T5; extracted to a graph fact by `brief-index` CB-T6), `dome.agent.brief:yesterday` (the ONE yesterday surface — dual-writer, §"The one yesterday block"), `dome.daily:questions` (deterministic "To decide" list), `dome.daily:integrated` (sweep-ledger digest), `dome.daily:sources` (honest sources record), `dome.agent.brief:compose-record` (the fingerprint-gate record, rendered last); `dome.daily:start-context`, `dome.agent.brief:questions`, `dome.agent.brief:integrated`, `dome.agent.brief:sources` (all retired-legacy — recognized, never written; migration notes in §"Block ownership" and below). | None — the yesterday block and the `dome.daily` blocks are excluded from task extraction (`dailyGeneratedBlockLineRanges`); the questions/integrated/sources blocks render plain bullets only. |
| `Meetings` | Today's agenda with vault-recall context. | Shared: `dome.daily.compose-blocks` (deterministic agenda) + `dome.agent.brief` (prep-context prose) + human additions (the `/morning` vault ritual overlap is a known accretion; D5 folds it). | `dome.daily:agenda` (top — deterministic time · title · attendees), `dome.agent.brief:meetings` (prep-context prose below — people, prior decisions, open threads; must not restate the agenda list). | None. |
| `Open Loops` | The ranked, source-backed open-loop surface. | Machine. | `dome.daily:open-loops`. | `dome.daily.reconcile-tasks` reads settled `[x]`/`[-]` copies inside the block and closes the origin line; task extractors skip the block (the copies are projections, not sources). |
| `Notes` | Free-form human capture. | Human. | None. (Ingest/capture-routed task lines land in `## Captured today`, not here.) | The task extractors: any checkbox/directive line outside generated blocks, fences, and frontmatter feeds `task-index` / `stamp-block-id` / carry-forward ranking. |
| `Decisions` | Decisions made today, one bullet each. | Human. | None. | `previousDailyDigest` (the mechanical yesterday extraction) and the brief's yesterday composition read it the next morning. |
| `Done` | What got finished today. | Shared: the deterministic `dome.daily:close` scaffold (D4) + human bullets/edits. | `dome.daily:close` (§"The close block"). | `previousDailyDigest` the next morning — when the close block exists, its kept done-candidates and still-open count are preferred over raw section scraping (§"The close block"). |
| `Story of the Day` | The narrative close. | Human, always — never model-written ([[daily]] decision ledger 3). | None, ever. | `previousDailyDigest` compresses the first paragraph into the next morning's story summary line. |

Sections are insertion-anchored, not positional: every splice helper inserts under its named heading and falls back to creating the heading rather than assuming an offset, so human reordering and prose between sections never break the writers.

## Block ownership

Every generated block that may appear in a daily note, with its writer, reader, and timing. Block ownership is **disjoint with one named exception** — no two processors write the same region, except `dome.agent.brief:yesterday`, the deliberate dual-writer block whose safety argument is §"The one yesterday block" — and every block uses the core marker grammar (`src/core/generated-block.ts`) with the splice-guard + anomaly-diagnostic contract from [[wiki/specs/task-lifecycle]] §"Generated-block markers (the splice-guard primitive)".

| Block | Hosted under | Writer | Content class | Timing | Status |
|---|---|---|---|---|---|
| `dome.daily:captured` | `## Captured today` | Skeleton (`renderDailySkeleton` renders it empty with a one-line comment hint) + `dome.agent.ingest` seam (the captured-tasks tool seam validates and splices task-line appends; the model never positions content) + `dome.agent.brief` (`addTask` — actionable findings from Slack/meeting sources, through the same validated captured splice; summary blocks stay checkbox-free) + human task lines | deterministic (open `- [ ] #task …` lines only — the seam rejects anything else) | skeleton at 05:30/06:00; appends whenever ingest routes a capture's tasks or the brief surfaces actionable findings | Shipping (D3). |
| `dome.daily:start-context` | — | **None — retired-legacy (D2).** | — | — | **Retired-legacy: recognized, never written.** The mechanical digest became the no-model fallback *body* of `dome.agent.brief:yesterday` (one yesterday-block, [[daily]] decision ledger 2). Migration: see §"The one yesterday block". |
| `dome.daily:open-loops` | `## Open Loops` | `carry-forward` (seeded by `create-daily`) | deterministic (ranked source-backed copies + resolved/dismissed-today subsections) | 06:00 + every adopted commit | Shipping. |
| `dome.daily:carried-forward` | — | **None — retired-legacy.** | — | — | **Retired-legacy: recognized, never written.** See verdict below. |
| `dome.daily:questions` | `## Start Here`, after the yesterday block | `dome.daily.compose-blocks` | deterministic — "To decide": top **3** open questions (owner-needed first, then oldest), one-line text, recommended answer when present, literal `dome resolve <id> <value>` command, `+N more — dome check` tail when capped; *removed entirely* when no open questions remain (resolving the last question cleans the page) | 05:25 cron + `questions.changed` / source-file / sweep-ledger signals | Shipping. Replaces `dome.agent.brief:questions` (never rendered — free rename). |
| `dome.daily:agenda` | `## Meetings`, top | `dome.daily.compose-blocks` | deterministic — time · title · attendees from `sources/calendar/<today>.md`, same defensive parser as the cockpit path; omitted entirely when no calendar file | 05:25 cron + `questions.changed` / source-file / sweep-ledger signals | Shipping. |
| `dome.daily:integrated` | `## Start Here`, after the questions block | `dome.daily.compose-blocks` | deterministic — sweep-ledger digest, renderer moved verbatim from the brief ([[wiki/specs/sweep]] §"Brief digest block") | 05:25 cron + `questions.changed` / source-file / sweep-ledger signals | Shipping. Replaces `dome.agent.brief:integrated`; omitted when the ledger is absent or today's run has no `integrated`/`questioned` rows. |
| `dome.daily:sources` | `## Start Here`, rendered after the integrated block | `dome.daily.compose-blocks` | deterministic — honest sources record, with entries rendered **only for source kinds whose day-file exists today** (a `dome.daily` processor cannot read `dome.sources` config, so file presence is the whole test); the block is omitted entirely when no source day-file exists — a vault with none landed gets no line at all, never a perpetual `calendar — · slack —` | 05:25 cron + `questions.changed` / source-file / sweep-ledger signals | Shipping. Replaces `dome.agent.brief:sources`; no longer the brief's re-compose gate — `dome.agent.brief:compose-record` (below) owns that. |
| `dome.agent.brief:today` | `## Start Here` | `dome.agent.brief` | model-written forward narrative for today — a grounded paragraph oriented toward now (current focus, intent, today's constraints), distinct from the yesterday digest. Splice position: top of `## Start Here`, above the yesterday block. Omitted entirely when the model is unavailable (no fallback prose). `dome.agent.brief-index` (adoption extractor) reads this block on every adopted daily-note commit and emits a `dome.agent.brief` fact (`predicate: "dome.agent.brief"`) carrying the stripped plain-text body and a sourceRef to the block; the fact drives the cockpit's brief panel in `dome today` and `GET /today`. | 05:30 (brief cron) | Shipping (CB-T5, CB-T6). |
| `dome.agent.brief:yesterday` | `## Start Here` | **Dual-writer:** `dome.agent.brief` (curated body, wholesale replace) + `create-daily`/`carry-forward` (mechanical fallback body, written ONLY when the block is absent) | model (spliced + grounded; every bullet cites `(from [[path]])`) over a deterministic fallback (prev-daily link, done/decisions/story compress; "no record of yesterday" line when no previous daily exists) | 05:30 (brief) · 06:00 + on-commit (presence-gated fallback) | Shipping. The ONE yesterday surface — §"The one yesterday block". |
| `dome.agent.brief:meetings` | `## Meetings` | `dome.agent.brief` | model (from the untrusted calendar file, handed to the model as data) | 05:30 | Shipping; omitted entirely when `sources/calendar/<today>.md` is absent. |
| `dome.agent.brief:questions` | — | **None — retired-legacy.** | — | — | **Retired-legacy: recognized, never written.** Superseded by `dome.daily:questions` (above). Migration: `dome.daily.compose-blocks` removes the old-namespace block from today's daily in the same patch that writes the replacement — one-time, idempotent; historical dailies untouched. |
| `dome.agent.brief:integrated` | — | **None — retired-legacy.** | — | — | **Retired-legacy: recognized, never written.** Superseded by `dome.daily:integrated` (above). Migration: `dome.daily.compose-blocks` removes the old-namespace block from today's daily in the same patch that writes the replacement — one-time, idempotent; historical dailies untouched. |
| `dome.agent.brief:sources` | — | **None — retired-legacy.** | — | — | **Retired-legacy: recognized, never written.** Superseded by `dome.daily:sources` (above). Migration: `dome.daily.compose-blocks` removes the old-namespace block from today's daily in the same patch that writes the replacement — one-time, idempotent; historical dailies untouched. |
| `dome.agent.brief:compose-record` | `## Start Here`, rendered last | `dome.agent.brief` | deterministic — one italic record line recording short content-hashes of the material inputs at last successful compose (`_Composed <n>× HH:MM · calendar@<hash8\|—> · slack@<hash8\|—> · ledger@<hash8\|—> · yesterday@<hash8\|—>_`; `—` when an input is absent), never model-written | every **successful** compose (05:30 cron + signal re-composes); the failure-stub path deliberately never writes it — a failed brief's recovery stays with its acknowledgeable question, never an automatic signal retry | Shipping. The fingerprint gate's entire state — §"Wake-tick choreography". |
| `dome.daily:close` | `## Done` | `close-scaffold` (presence-gated: written ONLY when the block is absent) | deterministic (done candidates from today's settled surface + still-open count + story pointer — never model prose, [[daily]] decision ledger 3) | 21:30 (schedule-only) | Shipping. The Close — §"The close block". |

`dome.daily:open-loops` is a bounded work queue, not an infinite cleanup
stream. On first render, carry-forward fills the open section from the ranked
source-backed candidate set. During the same day, resolved/dismissed rows that
the human leaves in the generated block count against the same cap, so settling
an item shrinks the open section instead of backfilling a fresh backlog item into
the vacated slot.

Brief blocks render plain `-` bullets only — never `- [ ]` checkboxes, which the task extractors would re-ingest as new tasks.

### The one yesterday block (D2)

`dome.agent.brief:yesterday` is the only yesterday surface in a daily note. There is exactly one block, one heading (`### Yesterday`), and never two yesterday summaries. Its body rides the degradation ladder: curated (model) → mechanical (deterministic fallback) → "no record of yesterday" (single line when no previous daily exists).

**Ownership.** The block keeps the brief's namespace — the edition compile is its steady-state, highest-fidelity writer, and renaming it (`dome.daily:yesterday`) would have orphaned every live brief block in existing vaults behind a second migration. `dome.daily`'s processors crossing into the `dome.agent.brief:*` namespace is the deliberate, recorded exception to disjoint ownership, made safe by two structural rules:

1. **The fallback write is presence-gated.** `create-daily` and `carry-forward` write the mechanical fallback body ONLY when the block is absent (`ensureYesterdayFallbackSection` in `daily-shared.ts`); when the block exists — whether it carries the brief's curated body or a previously seeded fallback — they leave it alone entirely. The brief, conversely, replaces the body wholesale (existing grounding + sanitize path unchanged). The writers are presence/replace-partitioned, so no interleaved partial writes are possible.
2. **One canonical block identity.** The `(owner, block)` pair is defined once, in `dome.daily`'s `daily-shared.ts` (`EDITION_YESTERDAY_BLOCK`, rendered through the core grammar primitive), and `dome.agent`'s `brief-shared.ts` imports it — the bundle dependency direction stays dome.agent → dome.daily, and the marker strings cannot drift apart.

**Fallback body shape** (deterministic, plain bullets, no checkboxes):

```
### Yesterday
- Previous daily: [[<prev daily>]]
- Done yesterday: <compress>               (omitted when empty)
- Yesterday's close was empty.             (D4: REPLACES the Done line when yesterday's close block is present with zero kept candidates)
- Still open at close: <N> loops carried.  (D4: only when yesterday's close block carries a parseable still-open count; always before Decisions)
- Decisions yesterday: <compress>          (omitted when empty)
- Story: <first-paragraph compress>        (omitted when empty)
```

The two D4 lines are the close block's contribution (§"The close block"): the close-empty line and the Done line are mutually exclusive (a present-but-empty close means explicit visible degradation, never a silent missing Done line), and the still-open line renders whenever the close's count parses — independent of whether the Done slot rendered candidates or the close-empty line. Implementation: `yesterdayFallbackSection` in `daily-shared.ts`.

When no previous daily exists, the body is the heading plus a single `- No record of yesterday — no previous daily note.` line.

**Grounding boundary.** The brief's grounding rule applies only to a body the *model* wrote: the splice compares the model's block body against the deterministic prepared body and skips the block when they are identical, so the mechanical fallback's bullets (which carry no `[[wikilink]]` beyond the prev-daily pointer) are never stripped as ungrounded.

**Task-extraction exclusion.** The block is in `dailyGeneratedBlockLineRanges`' excluded set alongside the `dome.daily` blocks: the mechanical fallback compresses human prose (Done/Decisions/Story) that may contain directive-shaped text ("follow up with…"), and generated copies must never re-ingest as tasks.

**Anomaly attribution.** Both writers scan the block at their own splice site: `carry-forward` reports anomalies under `dome.daily.generated-block-anomaly` (the block is in `DAILY_GENERATED_BLOCKS`), the brief under `dome.agent.generated-block-anomaly`. A hand-mangled marker may therefore surface under both codes — two reporters, one per splice site, each deduped at the diagnostics sink.

**Migration (`dome.daily:start-context` retirement).** No processor writes `start-context` anymore. When `create-daily`/`carry-forward`/`brief` touch today's daily and find an existing `dome.daily:start-context` block, they remove it in the same patch that ensures the unified block — one-time and idempotent (once removed, nothing recreates it). **Historical dailies keep theirs untouched**: they are closed records, and the daily writers only ever patch today's note. The marker stays in the recognized-block list (`DAILY_GENERATED_BLOCKS`) for anomaly detection and legacy non-reingestion, exactly as `carried-forward` is treated below.

### The `captured` block holds origins, not copies

Every other generated block in this table holds *projection* content — copies or digests of state whose source of truth lives elsewhere — so the task extractors skip their bodies. `dome.daily:captured` is the deliberate exception: a captured task **originates** in the daily; the block is its source of truth, not a mirror. Consequences, each pinned by tests:

- Captured-block lines are **inside** task extraction: `task-index` projects them into facts, `stamp-block-id` stamps their `^anchor`, `normalize-task-syntax` tidies them, and `carry-forward` ranks them into *future* dailies (today's own daily is never a carry-forward source for itself).
- A captured task settled in place (`[x]`/`[-]` inside the block) **stays settled where it is** — it carries no `(from [[origin]])` suffix, so `reconcile-tasks` never treats it as a settled copy to propagate, and the captured-tasks seam rejects appends carrying that suffix so a captured line can never masquerade as a copy.
- The search indexer does **not** strip the captured block (it strips only the projection blocks — `dome.daily:open-loops`, `dome.daily:carried-forward`, `dome.daily:close`, and `dome.agent.brief:yesterday`, whose copies/digests would otherwise duplicate settles and yesterday's sections in search results) — captured content is real vault content.

The marker pair is still anomaly-scanned like every other dome.daily block (`DAILY_GENERATED_BLOCKS`): smuggled duplicate pairs or half-open captured markers surface as `dome.daily.generated-block-anomaly` info diagnostics.

The brief may surface actionable Slack/meeting findings as captured `#task` lines via `addTask`; it writes them through the same validated captured splice (origins, not copies) and its summary blocks stay checkbox-free. Design: [[cohesive/brainstorms/2026-06-15-daily-phase2]].

### The ingest tool seam (who may write inside the block)

`dome.agent.ingest` is the machine writer, and it writes only through a guarded seam in its tool bindings (mirroring the preferences signals append-only guard):

- `appendToPage` on **today's** daily accepts only task-shaped lines — open `- [ ] …` checkboxes carrying the `#task`/`#followup` tag, with no HTML comment delimiters (marker injection), no `(from [[…]])` suffix (copy masquerade), and no U+2028/U+2029 line/paragraph separators (JS `m`-flag heading-anchor regexes treat LS/PS as line boundaries, so a smuggled separator + `## Done` would become a phantom insertion anchor for later heading-anchored splices). Valid lines are spliced *inside* the `dome.daily:captured` block by the seam (creating the full shared skeleton when today's daily is absent, so `create-daily`/the brief later no-op); anything else is rejected with a self-correctable tool error.
- **The seam is size-capped** (`CAPTURED_LINE_MAX_CHARS` = 500 chars per line, `CAPTURED_APPEND_MAX_LINES` = 10 lines per append — `daily-shared.ts`, mirroring the calendar parser's `MAX_TITLE_CHARS` philosophy: bounded fields on untrusted-adjacent input). An over-cap line or over-cap append is rejected with a self-correctable tool error naming the cap; a captured line is a one-line tactical task, and one routing pass lands a handful of them, never a bulk import.
- `writePage` on today's daily is admitted only when the rewrite is byte-identical outside the block and appends task-shaped lines inside it (same per-line and per-append caps — the rewrite path is not a bulk-import bypass); wholesale rewrites are rejected (other daily edits belong to the brief and the owner).

Other paths (entity `## Open threads` appends, wiki pages) are governed by the ordinary glob grant.

**Origin marker.** When the seam splices a captured task line, it stamps an
inline origin marker — ` ([↗](target))`, plain markdown, placed after the
description and before any block anchor — naming where the task came from. In
Phase 1 the target is the capture's *archived* path
(`inbox/processed/<name>`), computed deterministically by the processor (never
the model) so the link cannot point at the soon-deleted `inbox/raw/` path. The
marker is stamped *after* the `CAPTURED_LINE_MAX_CHARS` / shape validation, so
the cap measures the model-authored text and the marker is seam overhead; it is
idempotent (a line already carrying a marker is left alone), and becomes
ordinary source-of-truth markdown — so it survives `dome rebuild`. The marker
lives in the markdown line (clickable in Obsidian) but is stripped from the
*semantic task body* (`stripOriginMarker` in action-extraction) before that
body enters stable-id hashes, reconcile keys, or display text — so identity and
carry-forward matching are unaffected. The grammar takes an arbitrary target,
so a future external origin (a Slack permalink) reuses the same marker with no
new shape. Design: [[cohesive/brainstorms/2026-06-15-task-origin-links]].

### Captured-today heading repair

Real pre-D3 vaults accumulated duplicate `# Captured today` / `## Captured today` headings at mismatched levels. `dome.daily.normalize-task-syntax` carries a deterministic repair for **today's daily only** (historical dailies are untouched — past notes stay append-only): duplicate captured-today headings are merged into the single owned section — the section already holding the `dome.daily:captured` block wins, else the first; the kept heading is normalized to `## Captured today`; every body line from the merged sections is preserved (task lines and anchors verbatim) and spliced into the block, with dome marker-comment lines dropped (smuggled pairs must not survive a merge). The repair is idempotent (one correct heading → no-op) and emits one `dome.daily.captured-heading-repair` info diagnostic when it fires.

### The `carried-forward` verdict: retired-legacy

`dome.daily:carried-forward` has **no shipped call site that writes it** — the carry-forward processor evolved into the ranked `dome.daily:open-loops` surface, which fully absorbed the block's job (surface yesterday's unfinished work with `(from [[origin]])` provenance). The verdict is **retire as a writer concept, keep the marker recognized**:

- *Why not delete recognition:* real dailies written by earlier versions may carry the block. The grammar keeps it in `DAILY_GENERATED_BLOCKS`, so its contents stay excluded from task extraction (a legacy block's generated copies must not re-ingest as fresh tasks) and smuggled/mangled markers still surface as anomalies.
- *Why not reserve for future use:* the open-loops surface owns the carried-forward semantics, and the close owns its own `dome.daily:close` block (§"The close block"). A reserved-but-unwritten marker is exactly the kind of ambient accretion this spec exists to prevent.
- *Consequence:* no processor may adopt this marker for new output. The unused render/splice helpers (formerly `carriedForwardSection` / `replaceCarriedForwardSection` in `daily-scaffold.ts`) have been deleted; the recognition entries (`CARRIED_FORWARD_BLOCK`, `carriedForwardBlockRange` in `open-loop-surface.ts`) stay.

### The close block (D4)

`dome.daily:close` is the evening act's machine half: a deterministic scaffold the human confirms by deleting, not by writing. `dome.daily.close-scaffold` (cron `30 21 * * *`, schedule-only — the choreography table records why there is no file trigger) writes it under `## Done` in TODAY's daily. **When today's daily does not exist the run is a clean no-op** — the close needs a day to close; it never creates the skeleton.

**The evening window gate.** The processor fires only when `firedAt` falls in the evening window ([21:30, midnight) vault-local — the start matches the cron). The scheduler collapses missed fires to one immediate fire (`src/engine/operational/scheduler.ts`, "misfires collapse to one fire now"), so without the gate the first tick after enabling the bundle — or a host that slept through the evening and woke the next morning — would scaffold a premature close at whatever time it happens to be, freezing a wrong snapshot the presence gate then protects all day. A host down at 21:30 that returns later the same evening still closes; one that returns the next morning skips yesterday's close entirely, which the absent-close fallback row covers.

**Body shape** (deterministic, rendered by `closeScaffoldSection` in `daily-shared.ts`):

```
### Done today
Candidates from today's settles — keep what counts, delete the rest.
- <body> (from [[origin]])
- Dismissed: <body> (from [[origin]])
### Still open
- <N> loops still open — top: <body>; <body>; <body>
### Story of the Day
The story stays yours — write it in the ## Story of the Day section below; the close never generates prose.
```

- **Done candidates** are plain `-` bullets (never checkboxes — the block is also in the task-extraction excluded set). With zero candidates, the `### Done today` part is the heading plus a single non-bullet `Nothing recorded as settled today.` line — zero bullets is what "empty close" means to tomorrow's reader.
- **Still open** compresses to one bullet: the count plus the top 3 bodies in surface order; `- No loops still open.` when the surface is clear.
- **Story pointer** is a non-bullet reminder line. The close NEVER writes story content — `## Story of the Day` is human-only forever ([[daily]] decision ledger 3).

**Done-candidate derivation (the cheap one, recorded).** "Settled today" is derived from today's daily alone — no git history walk, no run-ledger read, no clock beyond the schedule's `firedAt` date:

1. Settled source-backed copies in today's daily (`- [x]`/`- [-]` … `(from [[origin]]) ^anchor` — `settledSourceBackedOpenLoopsFromMarkdown`). These are settled-today by construction: carry-forward renders only today's settles into today's `Resolved Today` / `Dismissed Today` subsections.
2. Settled plain checkbox lines written directly in today's daily outside generated blocks, fences, and frontmatter (`settledActionItemsFromMarkdown`) — tasks captured and finished in the note itself.

Candidates are deduped by normalized body across both sources. The honest limitation: an origin line settled directly in a *non-daily* file today never becomes a candidate unless it passed through today's surface — reconcile's settle flow means the surface copy is the normal path, and the cheap derivation accepts missing the bypass case rather than scanning file mtimes (file-level timestamps would false-positive every old settled line in a freshly touched file).

**Idempotency: presence-gated, like the yesterday fallback.** The scaffold writes the block ONLY when it is absent; an existing block — confirmed, edited, or emptied by the human — is left alone entirely. Consequences, all deliberate:

- Same day, same state → re-runs are byte-identical no-ops.
- A human-deleted candidate is NEVER resurrected — nothing inside the block is ever rewritten.
- Settles that land after the close are not appended; they appear in tomorrow's open-loops settled subsections and in tomorrow's close.
- To regenerate today's scaffold, delete the whole block (markers included) and re-run the processor.

**Tomorrow reads the close.** `previousDailyDigest` extracts the close digest (`closeDigestFromDailyContent`: the kept `### Done today` bullets + the parsed still-open count) from yesterday's daily and the mechanical yesterday fallback prefers it:

| Yesterday's close block | Fallback behavior |
|---|---|
| Present with kept bullets | `- Done yesterday: <kept compress>` from the block (raw `## Done` section scraping is skipped — the close is the authoritative done record) + `- Still open at close: N loops carried.` |
| Present but empty (zero kept bullets — written empty, or human deleted every candidate) | Explicit `- Yesterday's close was empty.` line (visible degradation, never silent thinness); the still-open count line still renders when parseable. |
| Absent (close skipped — host down at 21:30, or pre-D4 daily) | Raw section scraping, exactly as before D4. |

Decisions and Story compression are unaffected in every row — the close does not own those sections. The brief's pre-pass seed shares this upgrade automatically (it renders through the same `previousDailyDigest` + `yesterdayFallbackSection` pair).

**Task-extraction exclusion + anomaly attribution.** The block joins `DAILY_GENERATED_BLOCKS`: its contents never re-ingest as tasks, and both carry-forward (on every adopted commit) and close-scaffold (at its own splice site) surface mangled markers as `dome.daily.generated-block-anomaly` info diagnostics, deduped at the sink.

## The degradation ladder

Each rung is normative behavior, not best-effort. The edition never half-renders: a missing input degrades to a defined smaller package.

| Missing input | Normative behavior | Implementing processor |
|---|---|---|
| No model provider | The edition degrades to mechanical: `dome.daily.compose-blocks` still renders agenda + questions + integrated + sources at 05:25 from current inputs, the brief is a clean no-op (no error, no failed run — the warden no-op contract), `create-daily` writes the skeleton at 06:00 with the mechanical fallback body inside the unified `dome.agent.brief:yesterday` block (exactly one yesterday block, exactly once), and `carry-forward` raises the open-loops surface. The day still starts with a complete deterministic daily — agenda, questions, integrated, sources, open-loops, skeleton — a useful morning package with zero model. | `dome.daily.compose-blocks`, `dome.agent.brief` (no-op), `dome.daily.create-daily`, `dome.daily.carry-forward` |
| `questions.read` declared but `ctx.operational.questions` absent | A warning diagnostic `dome.daily.questions-view-missing` fires and the questions block is omitted — loud, never a silent empty render (the NEEDS_ARE_LOUD pattern applied locally; this rung was the original never-rendered-questions bug). | `dome.daily.compose-blocks` |
| Model present, writes nothing useful | The brief's deterministic pre-pass seeds the yesterday block with the mechanical fallback body before the model runs; a model that leaves the block untouched lands the fallback (the splice skips unchanged bodies — no grounding strip of deterministic bullets). | `dome.agent.brief` |
| No `sources/calendar/<today>.md` | The agenda block (compose-blocks) and the meetings prep-prose block (brief) are both omitted entirely — no empty section, no hallucinated agenda. The calendar file is untrusted input; absence means "no agenda known"; when the file lands, the signal renders the agenda within one compose-blocks tick, no model needed. | `dome.daily.compose-blocks`, `dome.agent.brief` |
| Source day-file lands after the brief composed (the wake-tick race) | The `file.created` signal re-composes the brief when the compose-record's per-input content hash no longer matches (calendar, slack, today's sweep-ledger section, yesterday's daily) — a deterministic pre-pass, capped at 3 model composes per day (info diagnostic beyond). Every other signal outcome is a free no-op (zero effects, zero model calls): no daily or no parseable compose-record means the brief has not successfully composed today (the cron or a manual run owns the first compose, and a failed brief's recovery stays with its question — signals never auto-retry a failure); an all-match hash means the daily already reflects current inputs. | `dome.agent.brief` |
| `dome.daily.compose-blocks` run fails | Deterministic ⇒ failure is a bug, not degradation: the normal deterministic-run failure path applies (run-ledger failure, quarantine after 3 consecutive failures per trigger, existing health question). The patch is atomic — never a half-written package. | `dome.daily.compose-blocks` |
| Nothing happened overnight | The integrated block is omitted (ledger absent or no renderable rows — signal, not log), and the mechanical yesterday fallback degrades to its quiet minimum: the previous-daily pointer line with no fabricated activity. | `dome.daily.compose-blocks` (integrated omission), `create-daily`/`carry-forward` (mechanical minimum) |
| No previous daily at all | The yesterday block still exists — its body is the heading plus a single "no record of yesterday" line. Never an absent block, never a fabricated digest. | `create-daily`/`carry-forward` (fallback), `dome.agent.brief` (pre-pass seed; the model may replace it with log.md-grounded bullets per its charter) |
| Brief run fails mid-flight | The model's edits roll back atomically, but the day is not abandoned: a deterministic fallback patch lands the pre-run prepared content (existing daily, or the re-seeded skeleton) with a failure stub spliced into the `dome.agent.brief:yesterday` block — the flattened error, yesterday's link, the retry command — plus a `dome.agent.brief-failed` warning and an acknowledgeable agent-safe question (`retried` / `skip-today`; no answer handler — resolution is the acknowledgment). A same-day re-failure replaces the stub via the marker splice, never duplicates it — and when the daily already carries a successful compose (compose-record present), a failed re-compose emits NO fallback patch at all: the good blocks stay, and the diagnostic + question carry the failure alone. Blast radius shrinks versus the pre-inversion design — the deterministic blocks are already on the page from 05:25. Normative at [[wiki/specs/autonomous-agents]] §"`dome.agent.brief`". | `dome.agent.brief` |
| Re-compose cap exhausted (3 model composes today) | The deterministic blocks (compose-blocks) keep updating live; the model narrative freezes for the day, plus an info diagnostic. | `dome.agent.brief` |
| Daily absent at 06:00 | `create-daily` writes the full skeleton; the brief already creates the same skeleton at 05:30 when it runs (even on failure, via the fallback-stub patch above), so this rung only fires when the brief didn't run at all (no model, host down at 05:30). One skeleton shape, two writers, last-writer no-ops. | `dome.daily.create-daily` |
| Close skipped entirely (no block — host down at 21:30, or a pre-D4 daily) | Tomorrow's yesterday digest falls back to raw section scraping — thin but honest; empty Done/Decisions compress to nothing rather than inventing content. | `create-daily`/`carry-forward`/`dome.agent.brief` (the shared fallback path) |
| Close written but emptied (block present, zero kept candidates) | Tomorrow's yesterday digest carries an explicit `- Yesterday's close was empty.` line — visible degradation, never silent thinness (§"The close block"). | `create-daily`/`carry-forward`/`dome.agent.brief` (the shared fallback path) |
| No daily at close time (21:30) | `close-scaffold` is a clean no-op — the close needs a day to close; it never creates the skeleton. | `dome.daily.close-scaffold` |
| Close fire collapsed outside the evening window (first-enable tick, host woke mid-day) | `close-scaffold` is a clean no-op — the evening window gate (§"The close block") refuses to freeze a premature snapshot; the next in-window fire closes normally. | `dome.daily.close-scaffold` |

## Doctor choreography findings

"Did my morning happen" is answerable without reading the daily. Two read-only findings in `src/engine/host/health.ts` (probe-only, idempotent, derived from the run ledger + the working tree — never an `error`, because the edition's absence is degradation, not corruption):

| Code | Severity | Fires when | Recovery points at |
|---|---|---|---|
| `daily.edition-not-compiled` | warning | `dome.agent.brief` is enabled, its scheduled time has passed today (derived from the manifest cron), the run ledger has no brief run started today, and the ledger records a brief run on some earlier day — the pipeline was alive before. A freshly enabled vault stays quiet until its first morning lands (recovery signal, not onboarding nag). | Check `dome serve` is running (cron fires only while the host runs) and the model-provider findings in the same report. |
| `daily.calendar-source-missing` | info | The brief is enabled and `sources/calendar/<date>.md` is absent for **both of the brief's two most recent run days** (≥ 2 ledger-evidenced mornings without an agenda — one missing day is normal). | The `dome.sources` calendar subscription ([[wiki/specs/sources]]) or the vault-side recipe at [[wiki/specs/vault-layout]] §"Populating the calendar file"; intentionally calendar-less vaults may ignore the info finding. |

Cheap-derivation calls, recorded: "existed at brief time" is approximated by *exists in the working tree now* for the run's date — calendar files are committed external feeds and are essentially never backfilled, and a backfill self-heals the finding, which is acceptable for info severity. "Consecutive days" is implemented as the brief's two most recent *run* days (ledger evidence), not wall-calendar days — a host that was off for a day must not manufacture or suppress the signal. Neither probe scans git history or projections.

`info` findings do not flip the doctor/check status: a report whose only findings are info-severity stays `ok` (summary carries `infoCount`), so a deliberately calendar-less vault is not permanently "unhealthy".

## Related

- [[daily]] — the plan of record; phases D2 (one yesterday), D3 (captured-today), D4 (the close), D5 (ritual fold)
- [[wiki/specs/task-lifecycle]] — block anchors, the splice-guard marker grammar, the hygiene processors, attention discounting
- [[wiki/specs/autonomous-agents]] — the brief's agent contract: grounding rule, marker-injection guard, grants, atomicity
- [[wiki/specs/sweep]] — the 03:00 integration run and the ledger grammar behind `dome.daily:integrated`
- [[wiki/specs/vault-layout]] — the calendar source-file shape and fetcher recipe
- [[wiki/linters/generated-block-splice-guard]] — the CI fence behind every block in §"Block ownership"
