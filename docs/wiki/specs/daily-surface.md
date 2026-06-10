---
type: spec
created: 2026-06-10
updated: 2026-06-10
sources:
  - "[[daily]]"
  - "[[wiki/specs/task-lifecycle]]"
  - "[[wiki/specs/autonomous-agents]]"
  - "[[wiki/specs/sweep]]"
---

# Daily surface

This spec is normative for the daily note as a *product surface* — the one file where the system and the owner meet. The mechanism layer (block grammar, splice guard, anchors, agents) is specified elsewhere and pointed at, not duplicated: [[wiki/specs/task-lifecycle]] owns block-anchor identity and the deterministic task processors, [[wiki/specs/autonomous-agents]] owns the brief's agent contract, [[wiki/specs/sweep]] owns the overnight integration whose digest the edition renders. This spec owns the *package*: which sections exist, who writes which block, the overnight choreography, and how the morning edition degrades.

Plan of record: [[daily]] (the daily-surface plan). This spec is its phase D1 contract; D2–D4 deltas are marked inline where they will land.

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
| 05:30 | `dome.agent.brief` | dome.agent | **The edition compile.** Composes the brief blocks into today's daily (creating the shared skeleton when absent, so create-daily later no-ops): yesterday digest, meetings, open-questions batch, integrated-overnight digest. |
| 06:00 | `dome.daily.create-daily` | dome.daily | Skeleton fallback: creates today's daily when nothing else did; writes the mechanical `dome.daily:start-context` digest (D2 retires this block — see §"Block ownership"). |
| 06:00 + on-commit | `dome.daily.carry-forward` | dome.daily | Raises the ranked `dome.daily:open-loops` surface; re-fires on every adopted commit so the surface tracks the live vault. |
| on-commit (daytime) | `dome.daily.stamp-block-id`, `normalize-task-syntax`, `reconcile-tasks`, `attention-discount`, `task-index` | dome.daily | The hygiene set: anchor stamping, cosmetic normalization, close-in-one-place reconcile, dismissal-derived discount facts, task facts. Normative at [[wiki/specs/task-lifecycle]]. |
| on-demand | `today`, `prep`, `agenda-with` | dome.daily | View-phase read-only projections of the live surface. |
| ~21:30 *(future, D4)* | `dome.daily.close-scaffold` | dome.daily | The Close: deterministic Done/unfinished scaffold under `## Done`; `Story of the Day` stays purely human. |

The edition pipeline is registered as the **`dome.daily.edition` maintenance loop** (`src/extensions/maintenance-loops.ts`): required processors `dome.agent.brief` + `dome.daily.create-daily` + `dome.daily.carry-forward`, with the calendar source named as path evidence (the loop schema has no free-text notes field; the calendar's external, vault-assembled nature is recorded in the loop's risks). The 02:00/03:00 stages stay owned by their own loops (`dome.link-concept.coherence`, `dome.meaning.integration`) — the edition loop covers the *compile*, not the whole night.

## The section contract

The skeleton (`renderDailySkeleton` in `assets/extensions/dome.daily/processors/daily-shared.ts`) is shared by `create-daily` and the brief — there is exactly one skeleton shape. Every `##` heading has a declared job, owner, and machine readers.

**This table is normative ([[daily]] decision ledger 4): any future processor that writes into a daily note must claim a row here (and a block row in §"Block ownership") before shipping.** Unclaimed writes are how the two-yesterdays and orphan-heading accretions happened.

| `##` heading | Job | Owner | Generated blocks hosted | Machine readers |
|---|---|---|---|---|
| `Start Here` | The first read of the morning — the edition's front page. | Shared: edition blocks + optional human prose. | `dome.agent.brief:yesterday`, `dome.agent.brief:questions`, `dome.agent.brief:integrated`; `dome.daily:start-context` (legacy — D2 retires it). | None — generated blocks are excluded from task extraction. |
| `Meetings` | Today's agenda with vault-recall context. | Shared: brief block + human additions (the `/morning` vault ritual overlap is a known accretion; D5 folds it). | `dome.agent.brief:meetings`. | None. |
| `Open Loops` | The ranked, source-backed open-loop surface. | Machine. | `dome.daily:open-loops`. | `dome.daily.reconcile-tasks` reads settled `[x]`/`[-]` copies inside the block and closes the origin line; task extractors skip the block (the copies are projections, not sources). |
| `Notes` | Free-form human capture. | Human. | None. (D3 adds a sibling `## Captured today` section with an owned `dome.daily:captured` block for ingest/capture-routed task lines.) | The task extractors: any checkbox/directive line outside generated blocks, fences, and frontmatter feeds `task-index` / `stamp-block-id` / carry-forward ranking. |
| `Decisions` | Decisions made today, one bullet each. | Human. | None. | `previousDailyStartContext` (the mechanical yesterday digest) and the brief's yesterday composition read it the next morning. |
| `Done` | What got finished today. | Human (D4 adds the deterministic `dome.daily:close` scaffold here). | None today. | Same next-morning readers as `Decisions`. |
| `Story of the Day` | The narrative close. | Human, always — never model-written ([[daily]] decision ledger 3). | None, ever. | `previousDailyStartContext` compresses the first paragraph into the next morning's story summary line. |

Sections are insertion-anchored, not positional: every splice helper inserts under its named heading and falls back to creating the heading rather than assuming an offset, so human reordering and prose between sections never break the writers.

## Block ownership

Every generated block that may appear in a daily note, with its writer, reader, and timing. Block ownership is **disjoint** — no two processors write the same region — and every block uses the core marker grammar (`src/core/generated-block.ts`) with the splice-guard + anomaly-diagnostic contract from [[wiki/specs/task-lifecycle]] §"Generated-block markers (the splice-guard primitive)".

| Block | Hosted under | Writer | Content class | Timing | Status |
|---|---|---|---|---|---|
| `dome.daily:start-context` | `## Start Here` | `create-daily` + `carry-forward` (shared helper) | deterministic ("Since Yesterday": prev-daily link, done/decisions/story compress) | 06:00 + on-commit | Shipping. **D2 retires the marker**: the mechanical digest becomes the no-model fallback *body* of `dome.agent.brief:yesterday` (one yesterday-block, [[daily]] decision ledger 2), and brief/create-daily treat an existing start-context block as the thing to replace once. |
| `dome.daily:open-loops` | `## Open Loops` | `carry-forward` (seeded by `create-daily`) | deterministic (ranked source-backed copies + resolved/dismissed-today subsections) | 06:00 + every adopted commit | Shipping. |
| `dome.daily:carried-forward` | — | **None — retired-legacy.** | — | — | **Retired-legacy: recognized, never written.** See verdict below. |
| `dome.agent.brief:yesterday` | `## Start Here` | `dome.agent.brief` | model (spliced + grounded; every bullet cites `(from [[path]])`) | 05:30 | Shipping. D2 absorbs `start-context` as its fallback body. |
| `dome.agent.brief:meetings` | `## Meetings` | `dome.agent.brief` | model (from the untrusted calendar file, handed to the model as data) | 05:30 | Shipping; omitted entirely when `sources/calendar/<today>.md` is absent. |
| `dome.agent.brief:questions` | `## Start Here`, after the yesterday block | `dome.agent.brief` | deterministic (the model never writes question ids) | 05:30 | Shipping. |
| `dome.agent.brief:integrated` | `## Start Here`, after the questions block | `dome.agent.brief` | deterministic — rendered from the sweep ledger's run sections for today, never model-written ([[wiki/specs/sweep]] §"Brief digest block") | 05:30 | Shipping; omitted when the ledger is absent or today's run has no `integrated`/`questioned` rows. |

Brief blocks render plain `-` bullets only — never `- [ ]` checkboxes, which the task extractors would re-ingest as new tasks.

### The `carried-forward` verdict: retired-legacy

`dome.daily:carried-forward` has rendering and splice helpers in `daily-shared.ts` (`carriedForwardSection`, `replaceCarriedForwardSection`) but **no shipped call site writes it** — the carry-forward processor evolved into the ranked `dome.daily:open-loops` surface, which fully absorbed the block's job (surface yesterday's unfinished work with `(from [[origin]])` provenance). The verdict is **retire as a writer concept, keep the marker recognized**:

- *Why not delete recognition:* real dailies written by earlier versions may carry the block. The grammar keeps it in `DAILY_GENERATED_BLOCKS`, so its contents stay excluded from task extraction (a legacy block's generated copies must not re-ingest as fresh tasks) and smuggled/mangled markers still surface as anomalies.
- *Why not reserve for future use:* the open-loops surface owns the carried-forward semantics, and D4's close gets its own `dome.daily:close` block. A reserved-but-unwritten marker is exactly the kind of ambient accretion this spec exists to prevent.
- *Consequence:* no processor may adopt this marker for new output. The unused render helpers may be deleted whenever convenient; the recognition entries stay.

## The degradation ladder

Each rung is normative behavior, not best-effort. The edition never half-renders: a missing input degrades to a defined smaller package.

| Missing input | Normative behavior | Implementing processor |
|---|---|---|
| No model provider | The edition degrades to mechanical: the brief is a clean no-op (no error, no failed run — the warden no-op contract), `create-daily` writes the skeleton + mechanical start-context digest at 06:00, and `carry-forward` raises the open-loops surface. The day still starts with a complete deterministic daily. | `dome.agent.brief` (no-op), `dome.daily.create-daily`, `dome.daily.carry-forward` |
| No `sources/calendar/<today>.md` | The meetings block is omitted entirely — no empty section, no hallucinated agenda. The calendar file is untrusted input; absence means "no agenda known". | `dome.agent.brief` |
| Nothing happened overnight | The integrated block is omitted (ledger absent or no renderable rows — signal, not log), and the yesterday digest degrades to its quiet minimum: the previous-daily pointer line with no fabricated activity. | `dome.agent.brief` (integrated omission), `create-daily`/`carry-forward` (mechanical minimum) |
| Daily absent at 06:00 | `create-daily` writes the full skeleton; the brief already creates the same skeleton at 05:30 when it runs, so this rung only fires when the brief didn't (no model, host down at 05:30, brief failed-and-rolled-back). One skeleton shape, two writers, last-writer no-ops. | `dome.daily.create-daily` |
| Close skipped (evening) | Tomorrow's yesterday digest is thin but explicit — empty Done/Decisions compress to nothing rather than inventing content. D4 upgrades this to an explicit "yesterday's close was empty" line. | `create-daily`/`carry-forward` today; `dome.daily.close-scaffold` at D4 |

## Doctor choreography findings

"Did my morning happen" is answerable without reading the daily. Two read-only findings in `src/engine/health.ts` (probe-only, idempotent, derived from the run ledger + the working tree — never an `error`, because the edition's absence is degradation, not corruption):

| Code | Severity | Fires when | Recovery points at |
|---|---|---|---|
| `daily.edition-not-compiled` | warning | `dome.agent.brief` is enabled, its scheduled time has passed today (derived from the manifest cron), and the run ledger has no brief run started today. | Check `dome serve` is running (cron fires only while the host runs) and the model-provider findings in the same report. |
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
