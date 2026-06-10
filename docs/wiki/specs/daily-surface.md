---
type: spec
created: 2026-06-10
updated: 2026-06-11
sources:
  - "[[daily]]"
  - "[[wiki/specs/task-lifecycle]]"
  - "[[wiki/specs/autonomous-agents]]"
  - "[[wiki/specs/sweep]]"
---

# Daily surface

This spec is normative for the daily note as a *product surface* — the one file where the system and the owner meet. The mechanism layer (block grammar, splice guard, anchors, agents) is specified elsewhere and pointed at, not duplicated: [[wiki/specs/task-lifecycle]] owns block-anchor identity and the deterministic task processors, [[wiki/specs/autonomous-agents]] owns the brief's agent contract, [[wiki/specs/sweep]] owns the overnight integration whose digest the edition renders. This spec owns the *package*: which sections exist, who writes which block, the overnight choreography, and how the morning edition degrades.

Plan of record: [[daily]] (the daily-surface plan). This spec is its phase D1 contract with the D2 delta (one yesterday block) and D3 (Captured today, owned) landed as shipped behavior; the D4 delta is marked inline where it will land.

## The three acts

The daily has exactly three jobs:

1. **Morning Edition (02:00–06:00, compiled).** One overnight pipeline — consolidate → sweep → calendar → edition compile — producing one package in today's daily note, with an explicit degradation ladder (§"The degradation ladder").
2. **Live Surface (daytime).** Capture lands in owned regions; hygiene (anchors, normalization, reconcile, discounting) is invisible; `today` / `prep` / `agenda-with` are read-only projections, never writers.
3. **Close (evening).** Currently unowned — `## Done`, `## Decisions`, `## Story of the Day` fill only if a vault-side ritual runs, and skipping silently thins tomorrow's edition. D4 makes the close first-class (`dome.daily.close-scaffold`, deterministic scaffold + human story; see [[daily]] §"D4 — The Close"). Until D4 lands, the close sections are human-owned and their emptiness is a known, visible degradation (the next morning's yesterday digest is simply thin).

## The 24-hour choreography

All times are vault-local; cron triggers fire only while the compiler host (`dome serve`) is running. The pipeline is ordered so each stage's output is the next stage's input.

| When | Processor / actor | Bundle | Role in the package |
|---|---|---|---|
| 02:00 | `dome.agent.consolidate` | dome.agent | Contractive janitor over recent drift — the graph the edition reads is already tidied. |
| 03:00 | `dome.agent.sweep` | dome.agent | Meaning integration ("no capture left behind"); writes tonight's `## Run <date>` section into the sweep ledger, which the edition digests. |
| ~05:10 | calendar fetcher — **vault-side, external, not shipped** | — | Commits `sources/calendar/<today>.md` before the brief. Recipe (launchd/cron + script or agent session) at [[wiki/specs/vault-layout]] §"Populating the calendar file (recipe, not shipped)". A missing file means "no agenda known". |
| 05:30 | `dome.agent.brief` | dome.agent | **The edition compile.** Composes the brief blocks into today's daily (creating the shared skeleton when absent, so create-daily later no-ops): yesterday digest (replacing the mechanical fallback body wholesale), meetings, open-questions batch, integrated-overnight digest. |
| 06:00 | `dome.daily.create-daily` | dome.daily | Skeleton fallback: creates today's daily when nothing else did; seeds the unified `dome.agent.brief:yesterday` block with the mechanical fallback body (§"The one yesterday block"). |
| 06:00 + on-commit | `dome.daily.carry-forward` | dome.daily | Raises the ranked `dome.daily:open-loops` surface; re-fires on every adopted commit so the surface tracks the live vault. Seeds the yesterday fallback block when (and only when) it is absent. |
| on-commit (capture) | `dome.agent.ingest` | dome.agent | Routes a capture's tactical tasks into today's daily — task-shaped lines spliced into the `dome.daily:captured` block by the tool seam (the model never positions). |
| on-commit (daytime) | `dome.daily.stamp-block-id`, `normalize-task-syntax`, `reconcile-tasks`, `attention-discount`, `task-index` | dome.daily | The hygiene set: anchor stamping, cosmetic normalization, close-in-one-place reconcile, dismissal-derived discount facts, task facts. Normative at [[wiki/specs/task-lifecycle]]. |
| on-demand | `today`, `prep`, `agenda-with` | dome.daily | View-phase read-only projections of the live surface. |
| ~21:30 *(future, D4)* | `dome.daily.close-scaffold` | dome.daily | The Close: deterministic Done/unfinished scaffold under `## Done`; `Story of the Day` stays purely human. |

The edition pipeline is registered as the **`dome.daily.edition` maintenance loop** (`src/extensions/maintenance-loops.ts`): required processors `dome.agent.brief` + `dome.daily.create-daily` + `dome.daily.carry-forward`, with the calendar source named as path evidence (the loop schema has no free-text notes field; the calendar's external, vault-assembled nature is recorded in the loop's risks). The 02:00/03:00 stages stay owned by their own loops (`dome.link-concept.coherence`, `dome.meaning.integration`) — the edition loop covers the *compile*, not the whole night.

## The section contract

The skeleton (`renderDailySkeleton` in `assets/extensions/dome.daily/processors/daily-shared.ts`) is shared by `create-daily` and the brief — there is exactly one skeleton shape. Every `##` heading has a declared job, owner, and machine readers.

**This table is normative ([[daily]] decision ledger 4): any future processor that writes into a daily note must claim a row here (and a block row in §"Block ownership") before shipping.** Unclaimed writes are how the two-yesterdays and orphan-heading accretions happened.

| `##` heading | Job | Owner | Generated blocks hosted | Machine readers |
|---|---|---|---|---|
| `Captured today` | The live capture landing zone — where the day's new tactical tasks land. First content section, above `Start Here` (matching the real-vault convention this section formalizes). | Shared: the skeleton renders it (empty block); `dome.agent.ingest` appends inside the block through its tool seam; humans may add task lines too. | `dome.daily:captured`. | The full task pipeline — captured lines are **origins, not copies**, so this is the one generated block whose body is *included* in task extraction (`task-index`, `stamp-block-id`, `normalize-task-syntax`, carry-forward ranking, search indexing). |
| `Start Here` | The first read of the morning — the edition's front page. | Shared: edition blocks + optional human prose. | `dome.agent.brief:yesterday` (the ONE yesterday surface — dual-writer, §"The one yesterday block"), `dome.agent.brief:questions`, `dome.agent.brief:integrated`; `dome.daily:start-context` (retired-legacy — recognized, never written; D2 verdict below). | None — the yesterday block and the `dome.daily` blocks are excluded from task extraction (`dailyGeneratedBlockLineRanges`); the questions/integrated blocks render plain bullets only. |
| `Meetings` | Today's agenda with vault-recall context. | Shared: brief block + human additions (the `/morning` vault ritual overlap is a known accretion; D5 folds it). | `dome.agent.brief:meetings`. | None. |
| `Open Loops` | The ranked, source-backed open-loop surface. | Machine. | `dome.daily:open-loops`. | `dome.daily.reconcile-tasks` reads settled `[x]`/`[-]` copies inside the block and closes the origin line; task extractors skip the block (the copies are projections, not sources). |
| `Notes` | Free-form human capture. | Human. | None. (Ingest/capture-routed task lines land in `## Captured today`, not here.) | The task extractors: any checkbox/directive line outside generated blocks, fences, and frontmatter feeds `task-index` / `stamp-block-id` / carry-forward ranking. |
| `Decisions` | Decisions made today, one bullet each. | Human. | None. | `previousDailyDigest` (the mechanical yesterday extraction) and the brief's yesterday composition read it the next morning. |
| `Done` | What got finished today. | Human (D4 adds the deterministic `dome.daily:close` scaffold here). | None today. | Same next-morning readers as `Decisions`. |
| `Story of the Day` | The narrative close. | Human, always — never model-written ([[daily]] decision ledger 3). | None, ever. | `previousDailyDigest` compresses the first paragraph into the next morning's story summary line. |

Sections are insertion-anchored, not positional: every splice helper inserts under its named heading and falls back to creating the heading rather than assuming an offset, so human reordering and prose between sections never break the writers.

## Block ownership

Every generated block that may appear in a daily note, with its writer, reader, and timing. Block ownership is **disjoint with one named exception** — no two processors write the same region, except `dome.agent.brief:yesterday`, the deliberate dual-writer block whose safety argument is §"The one yesterday block" — and every block uses the core marker grammar (`src/core/generated-block.ts`) with the splice-guard + anomaly-diagnostic contract from [[wiki/specs/task-lifecycle]] §"Generated-block markers (the splice-guard primitive)".

| Block | Hosted under | Writer | Content class | Timing | Status |
|---|---|---|---|---|---|
| `dome.daily:captured` | `## Captured today` | Skeleton (`renderDailySkeleton` renders it empty with a one-line comment hint) + `dome.agent.ingest` (the captured-tasks tool seam validates and splices task-line appends; the model never positions content) | deterministic (open `- [ ] #task …` lines only — the seam rejects anything else) | skeleton at 05:30/06:00; appends whenever ingest routes a capture's tasks | Shipping (D3). |
| `dome.daily:start-context` | — | **None — retired-legacy (D2).** | — | — | **Retired-legacy: recognized, never written.** The mechanical digest became the no-model fallback *body* of `dome.agent.brief:yesterday` (one yesterday-block, [[daily]] decision ledger 2). Migration: see §"The one yesterday block". |
| `dome.daily:open-loops` | `## Open Loops` | `carry-forward` (seeded by `create-daily`) | deterministic (ranked source-backed copies + resolved/dismissed-today subsections) | 06:00 + every adopted commit | Shipping. |
| `dome.daily:carried-forward` | — | **None — retired-legacy.** | — | — | **Retired-legacy: recognized, never written.** See verdict below. |
| `dome.agent.brief:yesterday` | `## Start Here` | **Dual-writer:** `dome.agent.brief` (curated body, wholesale replace) + `create-daily`/`carry-forward` (mechanical fallback body, written ONLY when the block is absent) | model (spliced + grounded; every bullet cites `(from [[path]])`) over a deterministic fallback (prev-daily link, done/decisions/story compress; "no record of yesterday" line when no previous daily exists) | 05:30 (brief) · 06:00 + on-commit (presence-gated fallback) | Shipping. The ONE yesterday surface — §"The one yesterday block". |
| `dome.agent.brief:meetings` | `## Meetings` | `dome.agent.brief` | model (from the untrusted calendar file, handed to the model as data) | 05:30 | Shipping; omitted entirely when `sources/calendar/<today>.md` is absent. |
| `dome.agent.brief:questions` | `## Start Here`, after the yesterday block | `dome.agent.brief` | deterministic (the model never writes question ids) | 05:30 | Shipping. |
| `dome.agent.brief:integrated` | `## Start Here`, after the questions block | `dome.agent.brief` | deterministic — rendered from the sweep ledger's run sections for today, never model-written ([[wiki/specs/sweep]] §"Brief digest block") | 05:30 | Shipping; omitted when the ledger is absent or today's run has no `integrated`/`questioned` rows. |

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
- Done yesterday: <compress>        (omitted when empty)
- Decisions yesterday: <compress>   (omitted when empty)
- Story: <first-paragraph compress> (omitted when empty)
```

When no previous daily exists, the body is the heading plus a single `- No record of yesterday — no previous daily note.` line.

**Grounding boundary.** The brief's grounding rule applies only to a body the *model* wrote: the splice compares the model's block body against the deterministic prepared body and skips the block when they are identical, so the mechanical fallback's bullets (which carry no `[[wikilink]]` beyond the prev-daily pointer) are never stripped as ungrounded.

**Task-extraction exclusion.** The block is in `dailyGeneratedBlockLineRanges`' excluded set alongside the `dome.daily` blocks: the mechanical fallback compresses human prose (Done/Decisions/Story) that may contain directive-shaped text ("follow up with…"), and generated copies must never re-ingest as tasks.

**Anomaly attribution.** Both writers scan the block at their own splice site: `carry-forward` reports anomalies under `dome.daily.generated-block-anomaly` (the block is in `DAILY_GENERATED_BLOCKS`), the brief under `dome.agent.generated-block-anomaly`. A hand-mangled marker may therefore surface under both codes — two reporters, one per splice site, each deduped at the diagnostics sink.

**Migration (`dome.daily:start-context` retirement).** No processor writes `start-context` anymore. When `create-daily`/`carry-forward`/`brief` touch today's daily and find an existing `dome.daily:start-context` block, they remove it in the same patch that ensures the unified block — one-time and idempotent (once removed, nothing recreates it). **Historical dailies keep theirs untouched**: they are closed records, and the daily writers only ever patch today's note. The marker stays in the recognized-block list (`DAILY_GENERATED_BLOCKS`) for anomaly detection and legacy non-reingestion, exactly as `carried-forward` is treated below.

### The `captured` block holds origins, not copies

Every other generated block in this table holds *projection* content — copies or digests of state whose source of truth lives elsewhere — so the task extractors skip their bodies. `dome.daily:captured` is the deliberate exception: a captured task **originates** in the daily; the block is its source of truth, not a mirror. Consequences, each pinned by tests:

- Captured-block lines are **inside** task extraction: `task-index` projects them into facts, `stamp-block-id` stamps their `^anchor`, `normalize-task-syntax` tidies them, and `carry-forward` ranks them into *future* dailies (today's own daily is never a carry-forward source for itself).
- A captured task settled in place (`[x]`/`[-]` inside the block) **stays settled where it is** — it carries no `(from [[origin]])` suffix, so `reconcile-tasks` never treats it as a settled copy to propagate, and the captured-tasks seam rejects appends carrying that suffix so a captured line can never masquerade as a copy.
- The search indexer does **not** strip the captured block (it strips only the projection blocks `open-loops`/`carried-forward`) — captured content is real vault content.

The marker pair is still anomaly-scanned like every other dome.daily block (`DAILY_GENERATED_BLOCKS`): smuggled duplicate pairs or half-open captured markers surface as `dome.daily.generated-block-anomaly` info diagnostics.

### The ingest tool seam (who may write inside the block)

`dome.agent.ingest` is the machine writer, and it writes only through a guarded seam in its tool bindings (mirroring the preferences signals append-only guard):

- `appendToPage` on **today's** daily accepts only task-shaped lines — open `- [ ] …` checkboxes carrying the `#task`/`#followup` tag, with no HTML comment delimiters (marker injection) and no `(from [[…]])` suffix (copy masquerade). Valid lines are spliced *inside* the `dome.daily:captured` block by the seam (creating the full shared skeleton when today's daily is absent, so `create-daily`/the brief later no-op); anything else is rejected with a self-correctable tool error.
- `writePage` on today's daily is admitted only when the rewrite is byte-identical outside the block and appends task-shaped lines inside it; wholesale rewrites are rejected (other daily edits belong to the brief and the owner).

Other paths (entity `## Open threads` appends, wiki pages) are governed by the ordinary glob grant.

### Captured-today heading repair

Real pre-D3 vaults accumulated duplicate `# Captured today` / `## Captured today` headings at mismatched levels. `dome.daily.normalize-task-syntax` carries a deterministic repair for **today's daily only** (historical dailies are untouched — past notes stay append-only): duplicate captured-today headings are merged into the single owned section — the section already holding the `dome.daily:captured` block wins, else the first; the kept heading is normalized to `## Captured today`; every body line from the merged sections is preserved (task lines and anchors verbatim) and spliced into the block, with dome marker-comment lines dropped (smuggled pairs must not survive a merge). The repair is idempotent (one correct heading → no-op) and emits one `dome.daily.captured-heading-repair` info diagnostic when it fires.

### The `carried-forward` verdict: retired-legacy

`dome.daily:carried-forward` has rendering and splice helpers in `daily-shared.ts` (`carriedForwardSection`, `replaceCarriedForwardSection`) but **no shipped call site writes it** — the carry-forward processor evolved into the ranked `dome.daily:open-loops` surface, which fully absorbed the block's job (surface yesterday's unfinished work with `(from [[origin]])` provenance). The verdict is **retire as a writer concept, keep the marker recognized**:

- *Why not delete recognition:* real dailies written by earlier versions may carry the block. The grammar keeps it in `DAILY_GENERATED_BLOCKS`, so its contents stay excluded from task extraction (a legacy block's generated copies must not re-ingest as fresh tasks) and smuggled/mangled markers still surface as anomalies.
- *Why not reserve for future use:* the open-loops surface owns the carried-forward semantics, and D4's close gets its own `dome.daily:close` block. A reserved-but-unwritten marker is exactly the kind of ambient accretion this spec exists to prevent.
- *Consequence:* no processor may adopt this marker for new output. The unused render helpers may be deleted whenever convenient; the recognition entries stay.

## The degradation ladder

Each rung is normative behavior, not best-effort. The edition never half-renders: a missing input degrades to a defined smaller package.

| Missing input | Normative behavior | Implementing processor |
|---|---|---|
| No model provider | The edition degrades to mechanical: the brief is a clean no-op (no error, no failed run — the warden no-op contract), `create-daily` writes the skeleton at 06:00 with the mechanical fallback body inside the unified `dome.agent.brief:yesterday` block (exactly one yesterday block, exactly once), and `carry-forward` raises the open-loops surface. The day still starts with a complete deterministic daily. | `dome.agent.brief` (no-op), `dome.daily.create-daily`, `dome.daily.carry-forward` |
| Model present, writes nothing useful | The brief's deterministic pre-pass seeds the yesterday block with the mechanical fallback body before the model runs; a model that leaves the block untouched lands the fallback (the splice skips unchanged bodies — no grounding strip of deterministic bullets). | `dome.agent.brief` |
| No `sources/calendar/<today>.md` | The meetings block is omitted entirely — no empty section, no hallucinated agenda. The calendar file is untrusted input; absence means "no agenda known". | `dome.agent.brief` |
| Nothing happened overnight | The integrated block is omitted (ledger absent or no renderable rows — signal, not log), and the mechanical yesterday fallback degrades to its quiet minimum: the previous-daily pointer line with no fabricated activity. | `dome.agent.brief` (integrated omission), `create-daily`/`carry-forward` (mechanical minimum) |
| No previous daily at all | The yesterday block still exists — its body is the heading plus a single "no record of yesterday" line. Never an absent block, never a fabricated digest. | `create-daily`/`carry-forward` (fallback), `dome.agent.brief` (pre-pass seed; the model may replace it with log.md-grounded bullets per its charter) |
| Daily absent at 06:00 | `create-daily` writes the full skeleton; the brief already creates the same skeleton at 05:30 when it runs, so this rung only fires when the brief didn't (no model, host down at 05:30, brief failed-and-rolled-back). One skeleton shape, two writers, last-writer no-ops. | `dome.daily.create-daily` |
| Close skipped (evening) | Tomorrow's yesterday digest is thin but explicit — empty Done/Decisions compress to nothing rather than inventing content. D4 upgrades this to an explicit "yesterday's close was empty" line. | `create-daily`/`carry-forward` today; `dome.daily.close-scaffold` at D4 |

## Doctor choreography findings

"Did my morning happen" is answerable without reading the daily. Two read-only findings in `src/engine/health.ts` (probe-only, idempotent, derived from the run ledger + the working tree — never an `error`, because the edition's absence is degradation, not corruption):

| Code | Severity | Fires when | Recovery points at |
|---|---|---|---|
| `daily.edition-not-compiled` | warning | `dome.agent.brief` is enabled, its scheduled time has passed today (derived from the manifest cron), the run ledger has no brief run started today, and the ledger records a brief run on some earlier day — the pipeline was alive before. A freshly enabled vault stays quiet until its first morning lands (recovery signal, not onboarding nag). | Check `dome serve` is running (cron fires only while the host runs) and the model-provider findings in the same report. |
| `daily.calendar-source-missing` | info | The brief is enabled and `sources/calendar/<date>.md` is absent for **both of the brief's two most recent run days** (≥ 2 ledger-evidenced mornings without an agenda — one missing day is normal). | The calendar recipe at [[wiki/specs/vault-layout]] §"Populating the calendar file (recipe, not shipped)"; intentionally calendar-less vaults may ignore the info finding. |

Cheap-derivation calls, recorded: "existed at brief time" is approximated by *exists in the working tree now* for the run's date — calendar files are committed external feeds and are essentially never backfilled, and a backfill self-heals the finding, which is acceptable for info severity. "Consecutive days" is implemented as the brief's two most recent *run* days (ledger evidence), not wall-calendar days — a host that was off for a day must not manufacture or suppress the signal. Neither probe scans git history or projections.

`info` findings do not flip the doctor/check status: a report whose only findings are info-severity stays `ok` (summary carries `infoCount`), so a deliberately calendar-less vault is not permanently "unhealthy".

## Related

- [[daily]] — the plan of record; phases D2 (one yesterday), D3 (captured-today), D4 (the close), D5 (ritual fold)
- [[wiki/specs/task-lifecycle]] — block anchors, the splice-guard marker grammar, the hygiene processors, attention discounting
- [[wiki/specs/autonomous-agents]] — the brief's agent contract: grounding rule, marker-injection guard, grants, atomicity
- [[wiki/specs/sweep]] — the 03:00 integration run and the ledger grammar behind `dome.agent.brief:integrated`
- [[wiki/specs/vault-layout]] — the calendar source-file shape and fetcher recipe
- [[wiki/linters/generated-block-splice-guard]] — the CI fence behind every block in §"Block ownership"
