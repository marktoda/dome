---
type: spec
created: 2026-05-27
updated: 2026-07-13
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
  - "[[v1]]"
  - "[[wedge]]"
  - "[[memory]]"
description: "Vault directory contract: wiki/raw/notes/inbox/meta roots and category table; raw immutable, notes never engine-written, meta/ generated bookkeeping, sources/ a committed feed"
---

# Vault layout

This spec is normative for the directory structure of a Dome vault.

## The vault root

A Dome vault is a git repository ([[wiki/invariants/VAULT_IS_GIT_REPO]]) containing:

```
<vault>/
  AGENTS.md           # canonical agent-orientation surface (per AGENTS_MD_IS_ORIENTATION_SURFACE)
  CLAUDE.md           # Claude Code shim pointing at AGENTS.md
  .dome/              # Dome configuration + derived state
  wiki/               # the compiled wiki (entities, concepts, dailies, syntheses, etc.)
  raw/                # immutable raw captures (per RAW_IS_IMMUTABLE)
  notes/              # user-authored content Dome reads but does not write
  inbox/              # ephemeral drop-zones for intake (per INBOX_IS_EPHEMERAL)
  attic/              # engine-proposed archive destination for dead-stub pages (see §"attic/")
  meta/               # generated bookkeeping — index shards + processor ledgers (engine-written; see §"meta/")
  log.md              # frozen history — activity lives in git, via `dome log` (per NO_ACCRETING_REGISTRIES)
  index.md            # generated render of the wiki/ catalogue map (dome.markdown.render-index; shards live in meta/)
  core.md             # always-loaded core memory page (see §"core.md" below)
```

`wiki/`, `raw/`, `notes/`, `inbox/`, `attic/`, and `meta/` are top-level directories. `log.md` and `index.md` are top-level files. Additional top-level directories that aren't recognized by Dome (e.g., the project's `cohesive/` substrate residue, `scripts/`, or anything else) are tolerated as **external** — readable, never written by the engine. `sources/` is one such external directory with a documented convention (see §"`sources/` — committed external feeds" below); `meta/` and `attic/` are the same convention with one carve-out each — `meta/` IS engine-written via explicit grants (see §"`meta/`" below), `attic/` is engine-**proposed** via `patch.propose` (see §"`attic/`" below).

## Category derivation

A document's category is derived from its path:

| Path prefix | Category |
|---|---|
| `raw/*` | `raw` |
| `wiki/*` | `wiki` |
| `notes/*` | `notes` |
| `inbox/*` | `inbox` |
| `log.md` | `log` |
| `index.md` | `index` |
| `.dome/*` | `config` |
| anything else | `external` |

The category is computed on demand from `document.path`; it is not stored. See [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]] §"Derived state".

## `wiki/` — the compiled wiki

The wiki is partitioned by type. Each direct child of `wiki/` corresponds to a page type:

```
wiki/
  entities/        # people, products, teams, projects, organizations
  concepts/        # ideas, threads, themes
  sources/         # external citations Dome considers durable
  syntheses/       # higher-order claims built from other pages
  dailies/         # daily notes (from the dome.daily bundle)
  weeklies/        # weekly notes (from the dome.daily bundle)
  decisions/       # explicit decision artifacts
  ... (extension-contributed types)
```

The four default types — entities, concepts, sources, syntheses — are SDK-shipped. Additional types come from extension bundles (per [[wiki/specs/sdk-surface]] §"Extension bundles"). A vault declares which extension types it uses in `<vault>/.dome/page-types.yaml`'s `extensions:` block.

A page's *type* (singular) is the directory name in `wiki/` mapped through the `singularOf`/`pluralOf` helpers in `src/page-type.ts` (e.g., `wiki/entities/danny.md` → type `entity`). The frontmatter `type:` field carries the singular form.

## `raw/` — immutable raw captures

`raw/` contains source materials Dome treats as **definitive** for citation. Voice transcripts, meeting notes, research clippings, source-of-truth artifacts. Files in `raw/` are immutable after creation per [[wiki/invariants/RAW_IS_IMMUTABLE]]. The raw-specific enforcement is shipped in two layers:

- `PatchEffect` targeting any `raw/<path>` is rejected by the broker, regardless of broad patch grants.
- `dome.markdown.raw-immutable` emits a blocking diagnostic if any Proposal modifies or deletes an existing `raw/` file.
- `dome.agent.ingest`'s ingest loop writes *new* `wiki/` pages citing the raw; it never modifies the raw.

Raw files may carry `type:` frontmatter naming the capture source (e.g., `type: voice-capture`, `type: research-clip`), but frontmatter is optional in v1 because raw material is user-owned and immutable after adoption. Subdirectory structure is convention, not contract — `raw/voice/`, `raw/meetings/`, `raw/clips/` are common but not required.

## `notes/` — user-authored content

`notes/` is user-owned. Dome **reads** notes; Dome does **not write** to notes. The asymmetry is by design — `notes/` is where the user keeps personal markdown that doesn't fit the wiki ontology. Lab books, personal journals, project memos. Frontmatter is optional; when present, Dome validates parseable structured fields but does not require `type:`.

`notes/` files do NOT emit `document.changed.notes.*` signals (the engine doesn't react to them). They emit only `vault.out-of-band-edit` for the watcher's drift-detection. The asymmetric ownership keeps the wiki / notes boundary clean.

## `inbox/` — ephemeral drop-zones

`inbox/` is where intake captures land before they're compiled into the wiki. Each subdirectory is an *intake bucket*:

```
inbox/
  raw/         # quick-capture target (dome.agent.ingest default)
  voice/       # voice capture target (opt-in via voice-ingest activation)
  research/    # research-clip target (opt-in)
  clip/        # share-sheet target (opt-in)
  review/      # dome.lint report destination (NOT an intake)
  processed/   # where dome.agent.ingest archives successfully-processed captures
```

Files in `inbox/<bucket>/` (except `inbox/review/` and `inbox/processed/`) are the trigger surface for that bucket's ingest processor via `signal:file.created` + a bucket path pattern. The shipped `dome.agent.ingest` processor handles `inbox/raw/*.md` — it runs a tool-use loop to read the raw source, create/update wiki pages (source, entities, concepts) with bidirectional wikilinks and one-line `description:` frontmatter (the index renders from it — agents never edit index files or `log.md`), route action-items to the daily note or entity pages, and archive the raw file to `inbox/processed/`. All edits land as one `PatchEffect`. The shipped `dome.agent.inbox-stale-check` processor emits `inbox.stale` warnings for old files that remain under active inbox buckets. Pinned by [[wiki/invariants/INBOX_IS_EPHEMERAL]] — inbox files are expected to move out or surface a recoverable diagnostic. See [[wiki/specs/autonomous-agents]] for the full agent framework and ingest workflow.

`inbox/review/` is the planned destination for dedicated lint reports. It is **not** an intake (no processor runs on writes to it). The user reviews lint reports there; applied findings produce engine commits annotating the report once the fuller lint workflow ships.

## `attic/` — engine-proposed archive (convention)

`attic/` is the destination for engine-**proposed** archive-moves of dead content — the mirror image of `inbox/`: files leaving the working vault instead of entering it. By the category table above `attic/*` derives `external` — like `meta/` and `core.md`, this is a documented convention, not a new category, with the same one carve-out as `meta/`: the engine touches it, here via `patch.propose` rather than `patch.auto`.

The shipped `dome.markdown.attic-sweep` janitor (garden phase, weekly cron `45 4 * * 0`) is the only first-party producer. It scans every tracked markdown page outside `attic/`, `inbox/`, `meta/`, `templates/`, and the daily-notes directory (`attic_exclude_prefixes` config, default `["attic/", "inbox/", "meta/", "templates/", "wiki/dailies/"]`) for **dead stubs** — a 0-byte page, or a basename matching `Untitled( N)?.md` — whose last human change is at least `attic_min_age_days` old (default 30; inclusive — a file changed exactly `attic_min_age_days` days ago qualifies). Oldest-first, capped at `attic_max_files` (default 20), it emits ONE `mode: "propose"` PatchEffect per run: for each candidate, a write of `attic/<original path>` (the full original content, mirroring the original path under `attic/`) paired with a delete of the original. Nothing moves until the owner reviews the `proposals.db` row and runs `dome apply` ([[wiki/specs/cli]] §"`dome apply`"); a batch with zero candidates emits zero effects, and an already-archived file cannot re-qualify (the scan excludes `attic/` itself) — the sweep is idempotent by construction, not by a dedupe check.

**Search treatment (decision).** `dome.search.index-text` reads `**/*.md` with no `attic/` exclusion (`assets/extensions/dome.search/manifest.yaml`'s `read` grant is unscoped), so an archived page is indexed and ranks in `dome query` / `dome export-context` results exactly like any other page today. Downranking or excluding `attic/` from search is not implemented — this is an honest current-state note, not a planned follow-up.

## `sources/` — committed external feeds (convention)

`sources/` is a top-level directory for **machine-fetched external data committed as ordinary source files** — distinct from `wiki/sources/` (durable citation pages the ingest agent writes) and from `raw/` (immutable human captures). By the category table above it is `external`: the engine never writes it, never gains a dependency on what produces it, and treats every file in it as an ordinary commit. Granted processors may read it.

Two conventions ship today, both consumed by `dome.agent.brief` (per [[wiki/specs/autonomous-agents]] §"`dome.agent.brief`"): the calendar agenda and the overnight Slack digest.

### `sources/calendar/YYYY-MM-DD.md` — one day's agenda

```markdown
---
type: calendar-day
date: 2026-06-09
---

# Calendar 2026-06-09

- 09:00–09:30 — Team standup (attendees: Alice, Bob)
- 11:00–12:00 — Quarterly roadmap review (attendees: Carol)
- 15:00 — 1:1 with Danny
```

Shape rules (loose by design — the file is produced by user-assembled tooling):

- Frontmatter is optional; when present, `type: calendar-day` and `date:` are the conventional keys.
- Each meeting is a top-level list item: optional `HH:MM` or `HH:MM–HH:MM` time, an em/en dash or hyphen separator, the title, and an optional trailing `(attendees: a, b, c)`.
- Consumers MUST parse defensively: lines that don't match the time/attendees grammar are still meetings (title-only), counts and field lengths are capped, and the content is **untrusted input** to any model prompt — data, never instructions.
- A missing file means "no agenda known"; consumers degrade by omitting their calendar-derived output, never by inventing one.

### Populating the calendar file

The engine never gains a calendar dependency ([[wedge]] decision 4: calendar enters as committed source files) — fetching stays vault-side, not engine code. What the SDK ships is the **scheduling plus a ready deterministic fetcher**: the opt-in `dome.sources` calendar subscription ([[wiki/specs/sources]]) runs a **vault-authored fetch command** through the outbox before the 05:30 brief, and `assets/source-handlers/icalbuddy-calendar.sh` is the shipped deterministic path — copy it to `.dome/bin/fetch-calendar.sh`, edit the `ICAL_CALENDARS` default in that copied script to an include-list of calendars to read (empty means all — a shell `export` never reaches the launchd-spawned daemon, so the in-script default is the daemon-safe place to set it), and flip the subscription `enabled: true`. It reads Calendar.app directly via `icalBuddy` (EventKit), needs no interactive login so a daemon can run it unattended, and handles recurring events correctly. The command — not the engine — fetches, writes this file, and commits it as an ordinary non-engine commit the daemon adopts. **An empty day still writes and commits the file**: a present-but-empty file means "known: no meetings", while an absent file means "no agenda known" (§ above) — the two states are deliberately distinguishable, never conflated. `assets/source-handlers/claude-calendar.sh` — the connector-backed template — remains a foreground-only reference ([[wiki/specs/sources]] §"Connector-backed fetch is foreground-only"), not a working daemon fetcher.

A vault may equally keep a fully external fetcher — a launchd/cron job, an AppleScript/EventKit script, or an MCP-driven agent session — landing the file via a plain git commit; the file contract is identical and the subscription's skip-if-present check treats the externally-committed file as done. `dome capture` is *not* the right ingress either way: it targets `inbox/raw/` and would route the agenda through the ingest agent instead.

**Alternative fetch:** a vault that prefers Google Calendar's API directly over EventKit — no macOS Calendar.app, or a non-Mac daemon host — can hand-roll a fetcher instead of adopting the shipped `icalbuddy-calendar.sh` template. Example sketch with [gcalcli](https://github.com/insanum/gcalcli) (adjust to taste; this is a recipe, not a supported artifact — when run as a subscription command, the date and output path arrive as `$1` and `$2`):

```sh
#!/bin/sh
# fetch-calendar.sh — run from the vault root before ~05:30
d="${1:-$(date +%F)}"
f="${2:-sources/calendar/$d.md}"
mkdir -p "$(dirname "$f")"
{
  printf -- '---\ntype: calendar-day\ndate: %s\n---\n\n# Calendar %s\n\n' "$d" "$d"
  gcalcli agenda "$d 00:00" "$d 23:59" --tsv \
    | awk -F'\t' '{ printf "- %s\xe2\x80\x93%s \xe2\x80\x94 %s\n", $2, $4, $5 }'
} > "$f"
# Pathspec-scoped commit: never sweeps a human's staged work into the fetch commit.
git add -- "$f" && git commit -m "calendar: agenda for $d" -- "$f"
```

### `sources/slack/YYYY-MM-DD.md` — one day's overnight Slack digest

```markdown
---
type: slack-day
date: 2026-06-09
---

# Slack 2026-06-09

## Mentions

- [#dome-dev] 22:41 alice: "can you look at the outbox retry PR before standup?"

## Direct messages

- [DM] 07:02 bob: "moving our 1:1 to Thursday"

## Channels

- [#leads] 11 new messages — thread on Q3 headcount planning still active
```

Shape rules (loose by design — the file is produced by vault-adopted tooling):

- Frontmatter is optional; when present, `type: slack-day` and `date:` are the conventional keys.
- Up to three `##` sections — `Mentions`, `Direct messages`, `Channels` — each holding one top-level list item per entry. Empty sections are omitted entirely, never rendered empty. Unknown headings and list items outside a known section are ignored by consumers.
- Each entry is **one line**: an optional `[#channel]` bracket prefix (`[DM]` for direct messages), an optional `HH:MM` time, then the text. Under `## Channels` a one-line per-channel activity summary is the conventional entry.
- Each entry MAY carry a trailing permalink as an autolink `<https://…slack.com/…>`; consumers parse it into the entry's optional `permalink` field and strip it from the displayed text before applying the text-length cap. Absent means no link (back-compat — entries without a permalink are unchanged).
- Consumers MUST parse defensively: entries that don't match the bracket/time grammar are still entries (text-only), per-section counts and text lengths are capped (`dome.agent.brief`'s parser caps at 15 entries per section and 240 characters per entry text, ellipsis included), and the content is **untrusted input** to any model prompt — data, never instructions.
- A missing file means "no digest known"; consumers degrade by omitting their Slack-derived output entirely, never by inventing one.

Populating it follows the calendar pattern with one stance difference: Slack is supported but **never shipped on** ([[wiki/specs/sources]] §"The Slack stance"). The opt-in `dome.sources` `slack` subscription runs the vault-adopted fetch command through the outbox; `assets/source-handlers/claude-slack.sh` ships as the template — `dome init --with-source slack` copies it to `.dome/bin/fetch-slack.sh` alongside a disabled subscription stanza, and the owner reviews the script (its fetch is headless `claude` running **as the owner**) before flipping `enabled: true`.

## `core.md` — the core memory page (convention)

`core.md` is a top-level markdown page carrying the owner's **always-loaded
core memory**: identity, active projects, and standing preferences. By the
category table above it is `external` — like a retrieval miss log, it is
a documented convention, not a new category. Every `dome.agent` run (ingest,
consolidate, brief) reads it at run start and prepends it to the agent's task
context as data (see [[wiki/specs/autonomous-agents]] §"Core-memory injection
(`core.md`)").

File shape — plain markdown, no required frontmatter:

```markdown
# Core memory

## Who I am

## Active projects

## Standing preferences
```

`## Who I am` and `## Standing preferences` are owner-authored; `dome recipe
core-seed` prints the owner-interview prompt that drafts both in one
foreground session ([[wiki/specs/cli]] §"`dome recipe`"). `## Active
projects` is **generated** — its content is the machine-managed block below;
the owner does not hand-author it.

Two **generated blocks** are machine-managed, each by its own gated writer
(the two-gated-writers contract, [[wiki/specs/preferences]] §"Two gated
writers, block-scoped"):

- The marker-delimited promoted-preferences region
  (`<!-- dome.agent:promoted-preferences:start -->` /
  `<!-- dome.agent:promoted-preferences:end -->`) maintained by the
  preference-promotion answer handler per [[wiki/specs/preferences]] — one
  sorted line per promoted rule (`- <topic>:: <rule> (confidence 0.NN)`).
  The handler creates the block after the `## Standing preferences` heading
  when absent.
- The `dome.agent:active-projects` region maintained by the deterministic
  `dome.agent.active-projects` renderer per [[wiki/specs/autonomous-agents]]
  §"`dome.agent.active-projects`" — one line per project page with current
  open loops, spliced under the `## Active projects` heading the init
  skeleton ships. The renderer refreshes an existing `core.md` only; it
  never recreates a deleted page.

Everything outside the markers is human prose.

**Size budget.** Core memory must stay small enough to load everywhere — it
is prepended to every agent run, so it is a context line-item, not a junk
drawer. `dome.markdown.core-size` emits a deterministic warning diagnostic
when `core.md` exceeds **6,000 characters**: split details into wiki pages
and keep only the always-relevant summary here. The lint checks the literal
top-level `core.md` path only; a vault configuring a custom
`extensions.dome.agent.config.core_path` forgoes the size lint (the simplest
honest contract — `dome.markdown` does not read `dome.agent`'s config).
The lint's effective read scope is `["core.md"] ∩ the vault's dome.markdown
read grant`, so the grant must cover `core.md` — the shipped default names
it explicitly (a vault that narrows the markdown read scope, e.g. to
`wiki/**`, silently kills the lint otherwise).

**The canonical grant shape (propose-only).** Interactive bundles read
`core.md` but never auto-write it: include `core.md` in the bundle's `read`
grant and **exclude it from every `patch.auto` grant**. Agents that want to
change core memory propose — a review patch or a `QuestionEffect` — and the
owner edits the page or accepts the proposal. The only auto-writers are the
two gated, block-scoped processors above — `preference-promotion-answer`
(the question *was* the review) and the deterministic `active-projects`
renderer — each via a narrow per-processor replacement grant, each owning a
distinct generated block; see [[wiki/specs/preferences]] §"Two gated
writers, block-scoped". This is decision 4 of the [[memory]] plan ledger,
evolved.

**Known gap: `dome.markdown`'s default `patch.auto: ["**/*.md"]` still
covers `core.md`** — deliberately, for now. Excluding it cannot produce the
quiet "review proposal" the propose-only intent imagines, because
`normalize-frontmatter` runs in the **adoption** phase: the broker downgrade
(auto→propose) requires an effective `patch.propose` grant dome.markdown
does not declare, so a bare grant exclusion yields a *deny* — and in the
adoption phase both a denied auto-patch and a downgraded propose-patch
escalate to `severity: "block"` diagnostics (`capability-deny-patch` /
`patch.propose.requires-review`) that refuse to adopt the human's own
commit, with no apply surface for that blocking path; worse, the broker
verdict is per-effect while `normalize-frontmatter` batches every changed
file into one PatchEffect, so a batch containing `core.md` would wedge the
unrelated files too. Product-review-4 shipped a garden-phase review queue
(`proposals.db` — a downgrade or `patch.propose` patch enqueues there and is
decided with `dome proposals` / `dome apply` / `dome reject`; [[wiki/specs/effects]]
§PatchEffect, "Garden phase, `mode: \"propose\"`"), but it doesn't reach an
adoption-phase processor. Since dome.markdown's writers are deterministic
hygiene (frontmatter key order, date refresh, wikilink repair), not
knowledge writers, the exclusion remains a follow-up — gated on moving
`normalize-frontmatter`'s `core.md` handling to the garden phase (or a
future adoption-phase apply surface) — tracked in
[[wiki/specs/preferences]] §"Follow-ups".

`dome init` scaffolds a commented `core.md` skeleton (first-write-only, never
overwritten on re-run) — see [[wiki/specs/cli]] §"dome init". `dome recipe
core-seed` is the seeding path for the owner-authored sections.

## `preferences/signals.md` — preference signals (convention)

`preferences/signals.md` is the **append-only preference-signal page** for
the promotion mechanism specced at [[wiki/specs/preferences]]. By the
category table above, `preferences/` is `external` — a documented convention,
not a new category. `dome init` scaffolds it as a heading plus a commented
grammar header (first-write-only — like `core.md` it is owner data; re-init
never clobbers accumulated signal lines, and there is no refresh path). One
dated, signed line per signal:

```markdown
- 2026-06-09 + filing:: meeting notes go under notes/, not entities/ (source: [[wiki/dailies/2026-06-09]])
```

`+` is a correction supporting the rule; `-` is evidence against it; the
topic slug is the aggregation key. Writers: the three `dome.agent` charters
(within their ordinary grants — the file is in each agent's `read` +
`patch.auto` declaration), foreground agents per the vault AGENTS.md
convention, the owner by hand, and the promotion answer handler (rejection
tombstones). The deterministic `dome.agent.preference-signals` processor
derives rebuildable `dome.preference.*` facts from it; malformed lines
degrade to one info diagnostic, never a crash. Append-only is convention
(legibility + stable line refs), not broker-enforced in v1.

## `meta/retrieval-misses.md` — retrieval-miss log (convention)

`meta/retrieval-misses.md` is the **append-only retrieval-miss log** —
the mechanical channel [[memory]] §"M6 — Banked embeddings design
(spec-only)" gates implementation of banked embeddings on ("implementation
proceeds when the log shows a real miss rate"). Task 12 built this channel
because the earlier convention — telling agents to "note the miss in the
relevant markdown" — was never operationalized; there was nowhere mechanical
to write it. By the category table above, `meta/` is `external`; unlike the
rest of `meta/` (engine-written via `patch.auto`), this file is
**human-commit-authored**, the same non-engine write path as
`preferences/signals.md`. Unlike `preferences/signals.md`, `dome init` does
NOT scaffold it — it is created lazily, with a header, on the first miss.
One dated line per miss:

```markdown
- 2026-06-12 — "auth retro decisions" — missed wiki/syntheses/auth-retro; found via manual grep for "retro"
```

Grammar (one line, no wrapping; [[wiki/specs/cli]] §"`dome query`" is
normative):

```
- YYYY-MM-DD — "<query>" — <note>
```

Writers: `dome query --miss [note]`, `dome export-context --miss [note]`,
and the MCP `report_miss` tool ([[wiki/specs/mcp-surface]]) — all three call
`reportMiss` (`src/surface/report-miss.ts`), the single collector that owns
the grammar (exported so nothing re-derives it), the header, and the commit
(`miss: <query first 40 chars>`, no `Dome-*` trailers — the same
commit-or-nothing seam as `dome capture`/`dome settle`; never opens the
runtime, never talks to the engine). `dome.health.report-card`
([[wiki/specs/daily-surface]] §"Report card") counts window-matched entries
by date each week; a missing file just omits that row, never an error.

## `meta/` — generated bookkeeping (convention)

`meta/` holds machine-owned rendered/support files: the per-category index shards
(`meta/index-<category>.md`, `-N` suffix on overflow, rendered by
`dome.markdown.render-index` — see §"`index.md`" below), retrieval misses,
and the weekly report card. Semantic gardening owns no markdown queue or
ledger; proposal decisions are its operational memory. By the category
table above `meta/*` derives `external`
— like `core.md`, this is a documented convention, not a new category, with
one carve-out: unlike other external directories, `meta/` IS engine-written,
via the explicit `patch.auto` grants each owner declares. Keeping the renders
and ledgers OUTSIDE `wiki/` is load-bearing: agent write grants are
`wiki/**`-shaped, so generated surfaces stay out of LLM blast radius by
construction, not by guard code — pinned by
[[wiki/invariants/NO_ACCRETING_REGISTRIES]]. The `index.md` catalogue map
itself stays at the vault root (its links point into `meta/`); it is
protected by grant *omission* — no agent grant covers it — not by location.
Root-level shards (`index-entities.md`) are the pre-`meta/` legacy layout;
the renderer retires them on the first run after upgrade (deleted when
nothing but the generated block and rendered title remains, spliced clean
when human prose surrounds it).

## `log.md` — frozen history

`log.md` is **frozen** (2026-06-11). The vault's activity record is git
history: every garden patch-application commit carries the PatchEffect's
sanitized narrative `reason` in its body plus the four `Dome-*` trailers
([[wiki/specs/adoption]] §"Engine commit trailers"), and `dome log`
([[wiki/specs/cli]] §"`dome log`") renders that history joined with the run
ledger. Nothing appends to `log.md`: no charter instructs it, the `dome.agent`
`patch.auto` grants exclude it (read stays granted — it remains background
context), and the grant-aware agent tools deny writes at tool time. Frozen
means no accretion and no model writes, not byte-immutability: the
deterministic source-preserving hygiene passes (wikilink repair, frontmatter
normalization) retain their covering `**/*.md` grants by design, so a page
rename does not strand broken links in the archive. Existing
content stays archived in place; vaults may rename it
(`log-archive-through-<date>.md`) but no rotation machinery exists.

The previously planned `dome.log` append-projection bundle is retired —
pinned by [[wiki/invariants/NO_ACCRETING_REGISTRIES]], which supersedes the
[[wiki/invariants/LOG_IS_APPEND_ONLY]] plan (frozen is append-only's
degenerate case: zero appends).

## `index.md` — generated wiki catalogue

`index.md` and its per-category shards (`meta/index-<category>.md`,
`meta/index-<category>-N.md` on overflow — generated bookkeeping under
`meta/`, per §"`meta/`" above; root-level shards are the legacy layout the
renderer retires) are **generated renders**, compiled by
the garden processor `dome.markdown.render-index` (cron `15 5 * * *` plus
wiki create/delete signals) from each page's one-line `description:`
frontmatter — the source of truth, projected as `dome.page.description` facts
and nudged by the info-severity `dome.markdown.missing-description` lint. The
catalog lives inside a `dome.markdown:index-catalog` generated block; owner
prose outside the block survives every rewrite. Pages opt out with
`index: false` frontmatter; a vault whose index stays curated disables
rendering outright with an explicitly empty `index_categories: {}` in
`dome.markdown`'s config (this docs vault does exactly that). The category
map and shard size are configurable (`index_categories`,
`index_shard_budget_chars`). A non-empty `index_categories` map MERGES over
the defaults — adding `notes/: notes` keeps the wiki categories — and a
prefix mapped to `false` removes that default (mapping every default to
`false` empties the merge, the same opt-out as explicit `{}`).

No model or agent edits an index file: the renderer is deterministic
(matching catalog → zero effects), and everything else is fenced out by the
same grant + tool-time exclusions as `log.md`. Pinned by
[[wiki/invariants/NO_ACCRETING_REGISTRIES]]. The previously planned
`dome.index` owns-path bundle is retired; staleness self-heals on the next
render tick rather than through `dome rebuild`. A one-shot migration script
(`scripts/migrate-index-descriptions.ts`) parses an existing hand-curated
`index.md` into per-page `description:` frontmatter.

## `.dome/` — configuration + derived state

```
<vault>/.dome/
  config.yaml             # vault config — invariant enable/disable, bundle grants, engine knobs
  model-provider.ts       # OPTIONAL — vault-local command model provider scaffold
  page-types.yaml         # default + extension page types declared for this vault
  extensions/             # OPTIONAL — vault-local third-party bundles
    <user-installed>/     # any user-installed bundle (directory copy)
                          # The SDK-shipped first-party bundles (dome.lint,
                          # dome.markdown, ...) live with the SDK and don't
                          # need to be copied here. See `extensions/` below.
  state/                  # derived operational state (gitignored)
    projection.db         # Bun.sqlite — facts, fts5, diagnostics, questions, schedule_cursors
    answers.db            # Bun.sqlite — durable answers to projection questions
    runs.db               # Bun.sqlite — run ledger
    outbox.db             # Bun.sqlite — external-action outbox
    quarantined.json      # processor quarantine state with generation ids
    last-reconcile-mtime.txt   # marker file; mtime is the signal
```

### `config.yaml`

The single config file. The accepted top-level keys are `extensions`,
`engine`, `git`, `ledger`, `model_provider`, and `shared_config`; unknown
top-level keys fail runtime open rather than being silently ignored.

`shared_config` holds vault-level keys that merge as *defaults* under every
extension's `config:` block (the extension's own key wins). It exists for
cross-bundle keys that must agree — `daily_path` is the canonical case:
`dome.daily` (create-daily) and `dome.agent` (brief, ingest) both resolve
the daily note from it, and declaring it once removes the mirrored-key
footgun (`config.daily-path-mismatch` in `dome doctor` then fires only on
an explicit per-extension fork).

```yaml
shared_config:
  daily_path: wiki/dailies/{date}.md   # optional; one declaration, every bundle sees it

model_provider:
  kind: command
  command: ["bun", ".dome/model-provider.ts"]

extensions:
  dome.markdown:
    enabled: true
    grants:
      read: ["wiki/**/*.md", ".dome/page-types.yaml", "**/*.{png,jpg,jpeg,gif,webp,svg,avif}"]
      patch.auto: ["wiki/**/*.md"]
      question.ask: true
    processors:
      dome.markdown.validate-wikilinks:
        grants: { read: ["**/*.md"] }
  dome.graph:    { enabled: true,  grants: { read: ["**/*.md"], graph.write: ["dome.graph.*"] } }
  dome.daily:    { enabled: true,  grants: { read: ["wiki/**/*.md"], patch.auto: ["wiki/**/*.md"], graph.write: ["dome.daily.*"], question.ask: true } }
  dome.health:   { enabled: true,  grants: { read: ["**"], question.ask: true, outbox.read: ["failed"], outbox.recover: true, quarantine.read: true, quarantine.recover: true, run.read: ["running"], run.recover: true } }
  dome.lint:     { enabled: true,  grants: { read: ["**/*.md"] } }
  dome.search:   { enabled: true,  grants: { read: ["**/*.md"], search.write: ["**/*.md"] } }
  dome.sources:                    # external-feed subscriptions ([[wiki/specs/sources]])
    enabled: true
    config:                        # the consent surface — per-subscription opt-in
      subscriptions:
        calendar:
          enabled: false           # shipped default: visible but off
          schedule: "10 5 * * *"
          output_path: "sources/calendar/{date}.md"
          command: ["sh", ".dome/bin/fetch-calendar.sh"]
    grants:
      read: ["sources/**/*.md", ".dome/config.yaml"]
      external: ["sources.fetch"]

engine:
  max_iterations: 100             # MAX_ITER for the fixed-point loop
  auto_commit_workflows: true     # whether closure commits land automatically
  # external_handler_timeout_ms: 300000   # per-attempt outbox handler bound (default 30000);
  #                                       # raise when a subscription fetch runs a headless model

git:
  auto_commit_workflows: true     # mirror of engine.auto_commit_workflows
```

`model_provider` is optional. `dome init --with-model-provider anthropic`
copies the shipped template (`<SDK>/assets/model-providers/anthropic.ts`) to a
vault-local `.dome/model-provider.ts` command adapter and adds the stanza
above. The command runs from the vault root, receives one JSON envelope on
stdin — `dome.model-provider.request/v1` (one-shot text),
`dome.model-provider.step/v1` (tool-use step), or
`dome.model-provider.probe/v1` (cheap liveness probe; see
[[wiki/specs/capabilities]] §"model.invoke") — and writes provider-neutral
JSON on stdout (for request/v1: `text`, optional `model`, optional `costUsd`).
The scaffold expects `ANTHROPIC_API_KEY` at runtime (default model
`claude-sonnet-4-6`, overridable via the envelope or `ANTHROPIC_MODEL`) and
keeps vendor API wiring outside the SDK core.
`dome.agent` ships enabled by default (with a $2/day `model.invoke` cap as
the guardrail); wiring the provider is what makes it act — until then the
host warns `agent.no-model-provider` at startup.

Vault identity is currently git-native (`HEAD`, current branch, and
`refs/dome/adopted/<branch>`), not a `vault:` config block. Axiom-tier
invariants are not user-toggleable. Run-ledger retention is opt-in per vault
via `ledger.retention_days` ([[wiki/specs/run-ledger]] §"Retention");
operational databases are otherwise preserved unless the user explicitly
removes them.

The legacy `engine.auto_resolve_questions` key is accepted for configuration
compatibility but ignored. Agent-safe decisions require a vault-aware
agent to inspect the cited evidence and call the normal durable resolve
operation; metadata and file existence alone never authorize an answer.

### `page-types.yaml`

```yaml
defaults:
  - entity
  - concept
  - source
  - synthesis

extensions:
  - name: daily
    frontmatter_extras: { recurrence: required }
  - name: weekly
    frontmatter_extras: { recurrence: required }
```

### `extensions/`

Each `<vault>/.dome/extensions/<bundle>/` is a bundle directory per [[wiki/specs/sdk-surface]] §"Bundle directory shape". The SDK-shipped first-party `dome.*` bundles do **not** live here in v1.0 — they ship with the SDK at `<SDK>/assets/extensions/` and are resolved at runtime via `resolveShippedBundlesRoot()`. The vault carries activations + grants in `.dome/config.yaml`; shipped bundle code is the SDK's responsibility.

`.dome/extensions/` is therefore **optional** and used for vault-local bundles: a third-party bundle the user installs, or a customized version of a shipped first-party bundle. Normal CLI/runtime use composes the shipped root plus `.dome/extensions/` when the directory exists; later roots override earlier roots by bundle id. Install by creating the bundle directory under `.dome/extensions/<bundle-id>/` and enabling it in `.dome/config.yaml`. `--bundles-root .dome/extensions` remains an exact override for tests and ad-hoc development.

### Derived operational state under `.dome/state/`

Gitignored operational state:

- `projection.db` — see [[wiki/specs/projection-store]].
- `answers.db` — durable answers to `QuestionEffect` rows.
- `runs.db` — see [[wiki/specs/run-ledger]].
- `outbox.db` — see [[wiki/specs/projection-store]] §"Outbox".
- `locks/operational-writers.db` — DELETE-journal cross-process writer
  coordination. It is excluded lock state rather than user data: backup and
  upgrade rollback never copy or restore it, and it must not use Dome's normal
  WAL connection configuration.
- `quarantined.json` — processor-quarantine state (carries forward from v0.5; persisted via the engine's quarantine-store helper). Each active quarantine has a `quarantineId` generation token so stale recovery answers cannot clear a newer quarantine for the same trigger key.
- `last-reconcile-mtime.txt` — mtime-only marker; consumed today by `dome status` (drift-state surface) and in v1.x by the planned `dome inspect drift-age` subject. The pre-recut `dome doctor --time-since-reconcile` flag is retired.

Per [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]], deleting `projection.db` and running `dome rebuild` reconverges the derived query cache. `answers.db`, `runs.db`, and `outbox.db` are persistent operational state, not rebuildable projections: wiping `answers.db` loses human question decisions, wiping `runs.db` loses historical run audit, and wiping `outbox.db` loses pending external actions. Users should delete only `projection.db` unless they are intentionally discarding operational history. Operational DB schema mismatches are refused and reported by `dome doctor`; they are not auto-wiped.

## Git repository structure

The vault IS the git repository. There is no separate `.dome.git` directory or alternate VCS:

- `<vault>/.git/` — git's internal storage.
- `<vault>/.gitignore` — engine-managed; ignores `.dome/state/` and OS metadata.
- `<vault>/refs/dome/adopted/<branch>` (git ref) — the adopted cursor per [[wiki/specs/adoption]].

Commits in the vault fall into two classes:

| Class | Identification | Examples |
|---|---|---|
| **User commits** | No `Dome-Run:` trailer | `git commit -m "..."` from any harness or shell |
| **Engine commits** | Carry the four Dome-* trailers | Closure commits; init scaffold commits |

`git log --grep="^Dome-Run:"` returns engine history; `git log --invert-grep --grep="^Dome-Run:"` returns user history.

## Ownership rules

The capability broker enforces ownership. Default rules:

| Path | Owner |
|---|---|
| `index.md`, `meta/index-*.md` (+ legacy root `index-*.md` during retirement) | `dome.markdown.render-index` (via `patch.auto`) — generated renders; agent grants exclude them |
| `log.md` | no agent or model-class writer; nothing appends entries — frozen history per [[wiki/invariants/NO_ACCRETING_REGISTRIES]] (deterministic source-preserving hygiene passes like wikilink repair retain covering grants by design); activity is git via `dome log` |
| `raw/**` | nobody — immutable per [[wiki/invariants/RAW_IS_IMMUTABLE]] |
| `core.md` | propose-only — agents read it; the only auto-writers are the two gated block-scoped processors (`dome.agent.preference-promotion-answer` → promoted-preferences block; `dome.agent.active-projects` → active-projects block), each via a narrow per-processor grant ([[wiki/specs/preferences]] §"Two gated writers, block-scoped") |
| `preferences/signals.md` | shared append surface — the three `dome.agent` charters, the promotion answer handler, foreground agents, and the owner all append signal lines (§"`preferences/signals.md`") |
| `meta/retrieval-misses.md` | no agent grant — the only writer is `reportMiss` (`src/surface/report-miss.ts`) via `dome query --miss`, `dome export-context --miss`, or the MCP `report_miss` tool, an ordinary human commit outside the broker entirely (§"`meta/retrieval-misses.md`") |
| `wiki/**/*.md` | open; `dome.daily.ambiguous-followup-answer` also has `patch.auto` for accepted follow-ups |
| `wiki/**/*.md` | `dome.agent.ingest` (via `patch.auto`, within grant) |
| `notes/**/*.md` | `dome.agent.ingest` (via `patch.auto`, within grant) — grant-as-boundary |
| `inbox/processed/**` | `dome.agent.ingest` (via `patch.auto`) |

Plugin / third-party bundles should not grant themselves write capability over the reserved registry paths (`index.md`, `meta/index-*.md`, legacy root `index-*.md`, `log.md`) — the index files belong to the deterministic renderer and `log.md` is frozen, per [[wiki/invariants/NO_ACCRETING_REGISTRIES]]. The broker enforces `owns.path` at patch-routing time; stricter config-load validation is future hardening.

## Why this layout

Four properties make the layout self-defending:

1. **Category by path.** Adding a new page type doesn't require schema work — create `wiki/<plural>/`, declare in `page-types.yaml extensions:`, write a processor that handles the type's signals.
2. **`raw/` immutability is structurally enforced.** Pinned by RAW_IS_IMMUTABLE; broker hard-deny plus `dome.markdown.raw-immutable` adoption diagnostics enforce it independent of first-party grants.
3. **`projection.db` is wipeable.** Derived query state can be rebuilt from markdown + git. Operational files in `.dome/state/` (`runs.db`, `outbox.db`) are persistent audit/retry state and should be preserved unless the user intentionally discards that history.
4. **`notes/` asymmetry keeps the wiki clean.** User-authored prose stays in notes; the wiki ontology stays curated by processors.

## Related

- [[wiki/specs/adoption]] — adopted ref under `refs/dome/`
- [[wiki/specs/projection-store]] — SQLite files under `.dome/state/`
- [[wiki/specs/run-ledger]] — `runs.db` under `.dome/state/`
- [[wiki/specs/page-schema]] — frontmatter contract per page type
- [[wiki/specs/sdk-surface]] §"Extension bundles" — `.dome/extensions/<bundle>/` shape
- [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]] — markdown + git are canonical knowledge; `.dome/state/` is derived/operational
- [[wiki/invariants/VAULT_IS_GIT_REPO]] — the vault root is a git repo
- [[wiki/invariants/INBOX_IS_EPHEMERAL]] — inbox bucket files are expected to move
- [[wiki/invariants/RAW_IS_IMMUTABLE]] — raw immutability target and enforcement plan
- [[wiki/invariants/NO_ACCRETING_REGISTRIES]] — index files are renders, `log.md` is frozen, activity is git history
