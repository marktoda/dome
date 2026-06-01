---
type: spec
created: 2026-05-27
updated: 2026-05-29
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
  - "[[v1]]"
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
```

`wiki/`, `raw/`, `notes/`, and `inbox/` are top-level directories. `log.md` and `index.md` are top-level files. Additional top-level directories that aren't recognized by Dome (e.g., the project's `cohesive/` substrate residue, `scripts/`, or anything else) are tolerated as **external** — readable, never written by the engine.

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
- `dome.intake`'s capture compilation writes *new* `wiki/` pages citing the raw; it never modifies the raw.

Raw files may carry `type:` frontmatter naming the capture source (e.g., `type: voice-capture`, `type: research-clip`), but frontmatter is optional in v1 because raw material is user-owned and immutable after adoption. Subdirectory structure is convention, not contract — `raw/voice/`, `raw/meetings/`, `raw/clips/` are common but not required.

## `notes/` — user-authored content

`notes/` is user-owned. Dome **reads** notes; Dome does **not write** to notes. The asymmetry is by design — `notes/` is where the user keeps personal markdown that doesn't fit the wiki ontology. Lab books, personal journals, project memos. Frontmatter is optional; when present, Dome validates parseable structured fields but does not require `type:`.

`notes/` files do NOT emit `document.changed.notes.*` signals (the engine doesn't react to them). They emit only `vault.out-of-band-edit` for the watcher's drift-detection. The asymmetric ownership keeps the wiki / notes boundary clean.

## `inbox/` — ephemeral drop-zones

`inbox/` is where intake captures land before they're compiled into the wiki. Each subdirectory is an *intake bucket*:

```
inbox/
  raw/         # quick-capture target (dome.intake default)
  voice/       # voice capture target (opt-in via voice-ingest activation)
  research/    # research-clip target (opt-in)
  clip/        # share-sheet target (opt-in)
  review/      # dome.lint report destination (NOT an intake)
  processed/   # where dome.intake archives successfully-processed captures
```

Files in `inbox/<bucket>/` (except `inbox/review/` and `inbox/processed/`) are the trigger surface for that bucket's intake processor via `signal:file.created` + a bucket path pattern. The shipped `dome.intake.extract-capture` processor handles `inbox/raw/*.md` and archives processed captures under `inbox/processed/` while writing generated pages under `wiki/generated/intake/`; `dome.intake.synthesize-capture` turns those generated capture pages into source-linked `wiki/syntheses/intake-*.md` pages. The shipped `dome.intake.inbox-stale-check` processor emits `inbox.stale` warnings for old files that remain under active inbox buckets. Pinned by [[wiki/invariants/INBOX_IS_EPHEMERAL]] — intake files are expected to move out or surface a recoverable diagnostic.

`inbox/review/` is the planned destination for dedicated lint reports. It is **not** an intake (no processor runs on writes to it). The user reviews lint reports there; applied findings produce engine commits annotating the report once the fuller lint workflow ships.

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

git:
  auto_commit_workflows: true     # mirror of engine.auto_commit_workflows
```

Vault identity is currently git-native (`HEAD`, current branch, and
`refs/dome/adopted/<branch>`), not a `vault:` config block. Axiom-tier
invariants are not user-toggleable. Ledger retention is not configurable in
v1; operational databases are preserved unless the user explicitly removes
them.

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
| `wiki/**/*.md` | open; `dome.daily.ambiguous-followup-answer` also has `patch.auto` for accepted follow-ups |
| `wiki/generated/intake/**` | `dome.intake` (via `patch.auto`) |
| `wiki/syntheses/intake-*.md` | `dome.intake` (via `patch.auto`, source-backed capture synthesis) |
| `inbox/processed/**` | `dome.intake` (via `patch.auto`) |
| `notes/**` | user only — engine never writes here |

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
