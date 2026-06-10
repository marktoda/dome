---
type: spec
created: 2026-05-27
updated: 2026-06-09
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
  - "[[v1]]"
  - "[[wedge]]"
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
  log.md              # append-only projection of the run ledger (per LOG_IS_APPEND_ONLY)
  index.md            # projection of wiki/ catalogue
  core.md             # always-loaded core memory page (see §"core.md" below)
```

`wiki/`, `raw/`, `notes/`, and `inbox/` are top-level directories. `log.md` and `index.md` are top-level files. Additional top-level directories that aren't recognized by Dome (e.g., the project's `cohesive/` substrate residue, `scripts/`, or anything else) are tolerated as **external** — readable, never written by the engine. `sources/` is one such external directory with a documented convention (see §"`sources/` — committed external feeds" below).

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

Files in `inbox/<bucket>/` (except `inbox/review/` and `inbox/processed/`) are the trigger surface for that bucket's ingest processor via `signal:file.created` + a bucket path pattern. The shipped `dome.agent.ingest` processor handles `inbox/raw/*.md` — it runs a tool-use loop to read the raw source, create/update wiki pages (source, entities, concepts) with bidirectional wikilinks, update `index.md` and `log.md`, route action-items to the daily note or entity pages, and archive the raw file to `inbox/processed/`. All edits land as one `PatchEffect`. The shipped `dome.agent.inbox-stale-check` processor emits `inbox.stale` warnings for old files that remain under active inbox buckets. Pinned by [[wiki/invariants/INBOX_IS_EPHEMERAL]] — inbox files are expected to move out or surface a recoverable diagnostic. See [[wiki/specs/autonomous-agents]] for the full agent framework and ingest workflow.

`inbox/review/` is the planned destination for dedicated lint reports. It is **not** an intake (no processor runs on writes to it). The user reviews lint reports there; applied findings produce engine commits annotating the report once the fuller lint workflow ships.

## `sources/` — committed external feeds (convention)

`sources/` is a top-level directory for **machine-fetched external data committed as ordinary source files** — distinct from `wiki/sources/` (durable citation pages the ingest agent writes) and from `raw/` (immutable human captures). By the category table above it is `external`: the engine never writes it, never gains a dependency on what produces it, and treats every file in it as an ordinary commit. Granted processors may read it.

The first convention is the calendar feed consumed by `dome.agent.brief` (per [[wiki/specs/autonomous-agents]] §"`dome.agent.brief`"):

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

### Populating the calendar file (recipe, not shipped)

The SDK ships **no calendar fetcher** and the engine never gains a calendar dependency ([[wedge]] decision 4: calendar enters as committed source files). The file is produced by a user-assembled fetcher that runs before the 05:30 brief — a launchd/cron job, an AppleScript/EventKit script, or an MCP-driven agent session — and lands via a plain git commit (the daemon adopts it like any other commit). `dome capture` is *not* the right ingress: it targets `inbox/raw/` and would route the agenda through the ingest agent instead.

Example sketch with [gcalcli](https://github.com/insanum/gcalcli) (adjust to taste; this is a recipe, not a supported artifact):

```sh
#!/bin/sh
# fetch-calendar.sh — run from the vault root before ~05:30
d=$(date +%F)
f="sources/calendar/$d.md"
mkdir -p sources/calendar
{
  printf -- '---\ntype: calendar-day\ndate: %s\n---\n\n# Calendar %s\n\n' "$d" "$d"
  gcalcli agenda "$d 00:00" "$d 23:59" --tsv \
    | awk -F'\t' '{ printf "- %s\xe2\x80\x93%s \xe2\x80\x94 %s\n", $2, $4, $5 }'
} > "$f"
git add "$f" && git commit -m "calendar: agenda for $d"
```

## `core.md` — the core memory page (convention)

`core.md` is a top-level markdown page carrying the owner's **always-loaded
core memory**: identity, active projects, and standing preferences. By the
category table above it is `external` — like `consolidation-ledger.md`, it is
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

One **generated block** is machine-managed: the marker-delimited
promoted-preferences region (`<!-- dome.agent:promoted-preferences:start -->`
/ `<!-- dome.agent:promoted-preferences:end -->`) maintained by the
preference-promotion answer handler per [[wiki/specs/preferences]] — one
sorted line per promoted rule (`- <topic>:: <rule> (confidence 0.NN)`). The
handler creates the block after the `## Standing preferences` heading when
absent. Everything outside the markers is human prose.

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
owner edits the page or accepts the proposal. The single auto-writer is the
shipped `dome.agent.preference-promotion-answer` handler (the question *was*
the review), which receives a narrow per-processor replacement grant — see
[[wiki/specs/preferences]] §"The single-auto-writer exception". This is
decision 4 of the [[memory]] plan ledger.

`dome init` scaffolds a commented `core.md` skeleton (first-write-only, never
overwritten on re-run) — see [[wiki/specs/cli]] §"dome init".

## `preferences/signals.md` — preference signals (convention)

`preferences/signals.md` is the **append-only preference-signal page** for
the promotion mechanism specced at [[wiki/specs/preferences]]. By the
category table above, `preferences/` is `external` — a documented convention,
not a new category. One dated, signed line per signal:

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

## `log.md` — append-only run-projection

`log.md` is a reserved markdown projection of the run ledger ([[wiki/specs/run-ledger]]) — the human-readable view of "what did Dome do." The planned `dome.log` adoption-phase processor will maintain it with `owns.path: ["log.md"]` capability ([[wiki/specs/capabilities]] §"owns.path").

Append-only: `dome.log` adds entries; nothing rewrites entries. Pinned by [[wiki/invariants/LOG_IS_APPEND_ONLY]]. Reconstruction from the ledger is planned through a repair/rebuild path once `dome.log` ships.

## `index.md` — wiki catalogue

`index.md` is a reserved markdown catalogue of every wiki page, partitioned by section. The planned `dome.index` adoption-phase processor will maintain it with `owns.path: ["index.md"]` capability.

Once `dome.index` ships, it should be rebuildable through `dome rebuild` when stale. (The pre-recut `dome doctor --rebuild-index` flag is retired in favor of the unified `dome rebuild` scope plus, in v1.x, `dome rebuild --target index` if a scoped rebuild is needed.)

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
`engine`, `git`, and `model_provider`; unknown top-level keys fail runtime
open rather than being silently ignored.

```yaml
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

engine:
  max_iterations: 100             # MAX_ITER for the fixed-point loop
  auto_commit_workflows: true     # whether closure commits land automatically
  auto_resolve_questions:          # optional; defaults to disabled
    enabled: false
    policies: ["agent-safe"]
    min_confidence: 0.6
    max_per_tick: 20

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
It does not enable `dome.agent`; model-capable bundles still require explicit
`extensions.<bundle>.enabled: true` plus effective `model.invoke` grants.

Vault identity is currently git-native (`HEAD`, current branch, and
`refs/dome/adopted/<branch>`), not a `vault:` config block. Axiom-tier
invariants are not user-toggleable. Ledger retention is not configurable in
v1; operational databases are preserved unless the user explicitly removes
them.

`engine.auto_resolve_questions`, when enabled, lets the operational pump answer
low-risk unresolved `QuestionEffect` rows that carry an allowed automation
policy, a confidence at or above `min_confidence`, SourceRefs that still exist
at the adopted ref, and a `recommendedAnswer` valid for the question options.
The answer is recorded in `answers.db`, mirrored onto the question row, and
dispatched through normal garden answer handlers; it does not create a second
state-editing path.

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
| `index.md` | planned `dome.index` (via `owns.path`) |
| `log.md` | planned `dome.log` (via `owns.path`) |
| `raw/**` | nobody — immutable per [[wiki/invariants/RAW_IS_IMMUTABLE]] |
| `core.md` | propose-only — agents read it; `dome.agent.preference-promotion-answer` is the sole auto-writer via a narrow per-processor grant ([[wiki/specs/preferences]]) |
| `preferences/signals.md` | shared append surface — the three `dome.agent` charters, the promotion answer handler, foreground agents, and the owner all append signal lines (§"`preferences/signals.md`") |
| `wiki/**/*.md` | open; `dome.daily.ambiguous-followup-answer` also has `patch.auto` for accepted follow-ups |
| `wiki/**/*.md` | `dome.agent.ingest` (via `patch.auto`, within grant) |
| `notes/**/*.md` | `dome.agent.ingest` (via `patch.auto`, within grant) — grant-as-boundary |
| `inbox/processed/**` | `dome.agent.ingest` (via `patch.auto`) |

Plugin / third-party bundles should not grant themselves `owns.path` on shipped-default reserved paths (`index.md`, `log.md`). The broker enforces `owns.path` at patch-routing time; stricter config-load validation is future hardening.

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
